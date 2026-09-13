import { randomUUID } from "node:crypto";
import {
  MaterialStatus,
  type PersonalMaterial,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import {
  getMaterialStaleSec,
  getRedisUrl,
} from "@/lib/config";
import { assertUuid } from "@/lib/course-access";
import { deleteObject, getObjectStream } from "@/lib/minio";
import {
  isOfficeMaterialFileType,
  previewPdfObjectKey,
} from "@/lib/material-office";
import type { RagQueueTask } from "@/lib/queue/ragTask";
import { enqueueMaterialTaskWithRetry } from "@/lib/material-ingestion";
import { getRedis } from "@/lib/redis";
import type {
  PersonalMaterialCreatedDto,
  PersonalMaterialDetailDto,
  PersonalMaterialSummaryDto,
} from "@/lib/dto/personal-material.dto";
import { mapStorageReadError } from "@/lib/material-storage-errors";
import {
  uploadMaterialCore,
  type PersonalMaterialUploadInput,
} from "@/lib/services/materialUploadService";

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

export async function uploadPersonalMaterialStream(
  params: PersonalMaterialUploadInput,
): Promise<PersonalMaterialCreatedDto> {
  return uploadMaterialCore({ ...params, scope: "personal" });
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
    await enqueueMaterialTaskWithRetry(task);
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
  };
  await enqueueMaterialTaskWithRetry(task);
}
