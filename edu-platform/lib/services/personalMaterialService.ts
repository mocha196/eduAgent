import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import {
  MaterialPreviewPdfStatus,
  MaterialStatus,
  type PersonalMaterial,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import {
  getMaterialMaxUploadBytes,
  getMaterialStaleSec,
  getMinioConfig,
  getRedisUrl,
} from "@/lib/config";
import { assertUuid } from "@/lib/course-access";
import { deleteObject, getObjectStream, putObjectStream } from "@/lib/minio";
import {
  isOfficeMaterialFileType,
  previewPdfObjectKey,
} from "@/lib/material-office";
import { enqueueRagTask, type RagQueueTask } from "@/lib/queue/ragTask";
import { getRedis } from "@/lib/redis";
import type {
  PersonalMaterialCreatedDto,
  PersonalMaterialDetailDto,
  PersonalMaterialSummaryDto,
} from "@/lib/dto/personal-material.dto";
import { MATERIAL_UPLOAD_ALLOWED_EXT_SET } from "@/lib/material-upload-allowed";
import { mapStorageReadError } from "@/lib/material-storage-errors";

async function enqueueWithRetry(task: RagQueueTask, maxAttempts = 5): Promise<void> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await enqueueRagTask(task);
      return;
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[personalMaterialService] enqueue attempt failed", {
        attempt: i + 1,
        maxAttempts,
        operation: task.operation,
        material_id: task.material_id,
        error: msg,
      });
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw last;
}

const ALLOWED_EXT = MATERIAL_UPLOAD_ALLOWED_EXT_SET;

const _VIDEO_FILE_TYPES = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv"]);
const _AUDIO_FILE_TYPES = new Set(["mp3", "wav", "m4a", "flac", "ogg", "opus"]);

function isVideoOrAudio(fileType: string): boolean {
  const t = fileType.toLowerCase();
  return _VIDEO_FILE_TYPES.has(t) || _AUDIO_FILE_TYPES.has(t);
}

function extToFileType(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg" || e === "png" || e === "webp") return "image";
  return e;
}

function parseExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0) return "";
  return filename.slice(i + 1);
}

const STALE_STATUSES = new Set<MaterialStatus>([
  MaterialStatus.PARSING,
  MaterialStatus.INDEXING,
  MaterialStatus.PARSED,
]);

async function reconcileStale(m: PersonalMaterial): Promise<PersonalMaterial> {
  if (!STALE_STATUSES.has(m.status)) return m;
  const staleSec = getMaterialStaleSec();
  if (Date.now() - m.updatedAt.getTime() < staleSec * 1000) return m;
  await prisma.personalMaterial.updateMany({
    where: { id: m.id, isDeleted: false, status: { in: [...STALE_STATUSES] } },
    data: {
      status: MaterialStatus.FAILED,
      statusMessage: "WORKER_ABANDONED: worker was likely interrupted or crashed",
    },
  });
  return (
    (await prisma.personalMaterial.findFirst({ where: { id: m.id, isDeleted: false } })) ?? m
  );
}

function toSummary(m: PersonalMaterial): PersonalMaterialSummaryDto {
  return {
    id: m.id,
    filename: m.originalFilename,
    file_type: m.fileType,
    status: m.status,
    preview_pdf_status: m.previewPdfStatus,
    indexed_chunk_count: m.indexedChunkCount,
    created_at: m.createdAt.toISOString(),
    status_message: m.statusMessage,
  };
}

export async function listPersonalMaterials(
  userId: string,
): Promise<{ materials: PersonalMaterialSummaryDto[] }> {
  const rows = await prisma.personalMaterial.findMany({
    where: { userId, isDeleted: false },
    orderBy: { createdAt: "desc" },
  });
  const reconciled = await Promise.all(rows.map(reconcileStale));
  return { materials: reconciled.map(toSummary) };
}

export async function getPersonalMaterial(
  userId: string,
  materialId: string,
): Promise<PersonalMaterialDetailDto> {
  assertUuid(materialId, "material_id");
  const m = await prisma.personalMaterial.findFirst({
    where: { id: materialId, userId, isDeleted: false },
  });
  if (!m) throw new ApiError(404, "NOT_FOUND", "Material not found");
  const reconciled = await reconcileStale(m);
  return {
    ...toSummary(reconciled),
    transcript: reconciled.transcriptText ?? null,
    video_summary: reconciled.videoSummary ?? null,
  };
}

export async function uploadPersonalMaterialStream(params: {
  userId: string;
  originalFilename: string;
  contentType: string | undefined;
  contentLength: number;
  body: ReadableStream<Uint8Array> | Readable;
  textOnly?: boolean;
  skipKg?: boolean;
}): Promise<PersonalMaterialCreatedDto> {
  try {
    getMinioConfig();
  } catch {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Object storage is not configured");
  }

  const max = getMaterialMaxUploadBytes();
  if (params.contentLength > max) {
    throw new ApiError(400, "VALIDATION_ERROR", "File too large", { max_bytes: max });
  }
  if (!getRedisUrl()) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "REDIS_URL is required for material processing");
  }

  const ext = parseExtension(params.originalFilename);
  if (!ext || !ALLOWED_EXT.has(ext.toLowerCase())) {
    throw new ApiError(400, "VALIDATION_ERROR", "Unsupported file type", {
      allowed: [...ALLOWED_EXT].sort(),
    });
  }

  const fileType = extToFileType(ext);
  const materialId = randomUUID();
  const safeName = params.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const minioPath = `personal_materials/${params.userId}/${materialId}/${safeName}`;
  const previewPdfStatus = isOfficeMaterialFileType(fileType)
    ? MaterialPreviewPdfStatus.PENDING
    : MaterialPreviewPdfStatus.NA;

  const nodeReadable =
    params.body instanceof Readable
      ? params.body
      : Readable.fromWeb(params.body as ReadableStream<Uint8Array>);

  try {
    await putObjectStream({
      objectKey: minioPath,
      body: nodeReadable,
      contentLength: params.contentLength,
      contentType: params.contentType,
    });
  } catch (e) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Object storage upload failed", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  let material: PersonalMaterial;
  try {
    material = await prisma.personalMaterial.create({
      data: {
        id: materialId,
        userId: params.userId,
        originalFilename: params.originalFilename,
        fileType,
        fileSize: params.contentLength,
        minioPath,
        previewPdfStatus,
        status: MaterialStatus.UPLOADED,
      },
    });
  } catch (e) {
    await deleteObject(minioPath).catch(() => {});
    throw new ApiError(500, "INTERNAL_ERROR", "Failed to persist material after upload", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const textOnly = params.textOnly ?? true;
  const skipKg = params.skipKg ?? true;
  const operation = isOfficeMaterialFileType(fileType)
    ? ("personal_convert_preview" as const)
    : isVideoOrAudio(fileType)
    ? ("personal_transcribe_and_index" as const)
    : ("personal_parse_and_index" as const);

  const task: RagQueueTask = {
    task_id: randomUUID(),
    material_id: materialId,
    operation,
    created_at: new Date().toISOString(),
    text_only: textOnly,
    skip_kg: skipKg,
  };
  try {
    await enqueueWithRetry(task);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.personalMaterial.updateMany({
      where: { id: materialId, userId: params.userId, isDeleted: false },
      data: {
        status: MaterialStatus.FAILED,
        statusMessage: `QUEUE_ENQUEUE_FAILED: ${msg.slice(0, 500)}`,
      },
    });
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Failed to queue material processing",
      { detail: msg },
    );
  }

  return {
    id: material.id,
    original_filename: material.originalFilename,
    status: material.status,
    created_at: material.createdAt.toISOString(),
  };
}

export async function deletePersonalMaterial(
  userId: string,
  materialId: string,
): Promise<void> {
  assertUuid(materialId, "material_id");
  const m = await prisma.personalMaterial.findFirst({
    where: { id: materialId, userId, isDeleted: false },
  });
  if (!m) throw new ApiError(404, "NOT_FOUND", "Material not found");

  if (!getRedisUrl()) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "REDIS_URL is required to queue RAG cleanup");
  }

  const task: RagQueueTask = {
    task_id: randomUUID(),
    material_id: materialId,
    operation: "personal_delete_material",
    created_at: new Date().toISOString(),
  };

  await prisma.personalMaterial.update({
    where: { id: materialId },
    data: { isDeleted: true },
  });

  try {
    await enqueueWithRetry(task);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.personalMaterial.update({
      where: { id: materialId },
      data: { statusMessage: `RAG_DELETE_QUEUE_FAILED: ${msg}` },
    });
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Failed to queue RAG cleanup after delete", {
      detail: msg,
    });
  }

  await deleteObject(m.minioPath);
  if (isOfficeMaterialFileType(m.fileType)) {
    await deleteObject(previewPdfObjectKey(m.minioPath)).catch(() => {});
  }
}

export async function streamPersonalMaterialContent(
  userId: string,
  materialId: string,
  rangeHeader: string | null,
): Promise<Response> {
  assertUuid(materialId, "material_id");
  const m = await prisma.personalMaterial.findFirst({
    where: { id: materialId, userId, isDeleted: false },
  });
  if (!m) throw new ApiError(404, "NOT_FOUND", "Material not found");

  try {
    const result = await getObjectStream({ objectKey: m.minioPath, range: rangeHeader ?? undefined });
    const headers = new Headers();
    headers.set("Content-Type", result.contentType ?? "application/octet-stream");
    headers.set("Accept-Ranges", "bytes");
    if (result.contentLength != null) headers.set("Content-Length", String(result.contentLength));
    if (result.contentRange) headers.set("Content-Range", result.contentRange);

    const status = result.isPartial ? 206 : 200;
    return new Response(result.body, { status, headers });
  } catch (e) {
    throw mapStorageReadError(e);
  }
}

export async function cancelPersonalMaterial(
  userId: string,
  materialId: string,
): Promise<void> {
  assertUuid(materialId, "material_id");
  const m = await prisma.personalMaterial.findFirst({
    where: { id: materialId, userId, isDeleted: false },
  });
  if (!m) throw new ApiError(404, "NOT_FOUND", "Material not found");

  const r = await getRedis();
  if (!r) throw new ApiError(503, "SERVICE_UNAVAILABLE", "Redis is not available");

  await r.set(`cancel_material:${materialId}`, "1", { EX: 300 });
}

export async function getOrCreatePersonalKbSession(userId: string): Promise<{ agent_session_id: string }> {
  const existing = await prisma.personalKbSession.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return { agent_session_id: existing.agentSessionId };

  const agentSessionId = randomUUID();
  await prisma.personalKbSession.create({
    data: { userId, agentSessionId },
  });
  return { agent_session_id: agentSessionId };
}

export async function createPersonalKbSession(userId: string): Promise<{ agent_session_id: string }> {
  const agentSessionId = randomUUID();
  await prisma.personalKbSession.create({
    data: { userId, agentSessionId },
  });
  return { agent_session_id: agentSessionId };
}

export async function retryPersonalMaterialIndex(
  userId: string,
  materialId: string,
  textOnly?: boolean,
  skipKg?: boolean,
): Promise<void> {
  assertUuid(materialId, "material_id");
  if (!getRedisUrl()) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "REDIS_URL is required to queue RAG index retry");
  }
  const m = await prisma.personalMaterial.findFirst({
    where: { id: materialId, userId, isDeleted: false },
  });
  if (!m) {
    throw new ApiError(404, "NOT_FOUND", "Material not found");
  }
  if (m.status !== MaterialStatus.FAILED) {
    throw new ApiError(
      409,
      "CONFLICT",
      "Only materials in FAILED status can retry indexing from cached parse output",
      { status: m.status },
    );
  }
  const task: RagQueueTask = {
    task_id: randomUUID(),
    material_id: materialId,
    operation: "personal_index_only",
    created_at: new Date().toISOString(),
    text_only: textOnly ?? true,
    skip_kg: skipKg ?? true,
  };
  await enqueueWithRetry(task);
}
