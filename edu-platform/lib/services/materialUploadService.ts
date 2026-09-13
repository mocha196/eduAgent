import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { MaterialPreviewPdfStatus, MaterialStatus, UserRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import { getMaterialMaxUploadBytes, getMinioConfig, getRedisUrl } from "@/lib/config";
import { assertTeacherOfCourse, assertUuid } from "@/lib/course-access";
import { deleteObject, putObjectStream } from "@/lib/minio";
import { isOfficeMaterialFileType } from "@/lib/material-office";
import { enqueueMaterialTaskWithRetry, initialMaterialOperation } from "@/lib/material-ingestion";
import { MATERIAL_UPLOAD_ALLOWED_EXT_SET } from "@/lib/material-upload-allowed";
import type { RagQueueTask } from "@/lib/queue/ragTask";
import type { MaterialCreatedDto } from "@/lib/dto/material.dto";

type CommonUploadInput = {
  originalFilename: string;
  contentType: string | undefined;
  contentLength: number;
  body: ReadableStream<Uint8Array> | Readable;
  textOnly?: boolean;
};

export type CourseMaterialUploadInput = CommonUploadInput & {
  teacherUserId: string;
  role: UserRole;
  courseId: string;
  lessonId?: string | null;
};

export type PersonalMaterialUploadInput = CommonUploadInput & {
  userId: string;
};

type ScopedUploadInput =
  | (CourseMaterialUploadInput & { scope: "course" })
  | (PersonalMaterialUploadInput & { scope: "personal" });

function fileTypeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  if (!MATERIAL_UPLOAD_ALLOWED_EXT_SET.has(ext)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Unsupported file type", {
      allowed: [...MATERIAL_UPLOAD_ALLOWED_EXT_SET].sort(),
    });
  }
  // Image extensions are not currently allowed, but retain the existing normalization.
  return ["jpg", "jpeg", "png", "webp"].includes(ext) ? "image" : ext;
}

async function assertUploadPrerequisites(params: ScopedUploadInput): Promise<void> {
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

  if (params.scope === "course") {
    await assertTeacherOfCourse(params.teacherUserId, params.role, params.courseId);
    if (params.lessonId) {
      assertUuid(params.lessonId, "lesson_id");
      const lesson = await prisma.lesson.findFirst({
        where: { id: params.lessonId, courseId: params.courseId, isDeleted: false },
      });
      if (!lesson) {
        throw new ApiError(404, "NOT_FOUND", "Lesson not found");
      }
    }
  }
}

/** Shared upload pipeline; ownership-specific persistence stays explicit and type-checked. */
export async function uploadMaterialCore(params: ScopedUploadInput): Promise<MaterialCreatedDto> {
  await assertUploadPrerequisites(params);

  const fileType = fileTypeFromFilename(params.originalFilename);
  const materialId = randomUUID();
  const safeName = params.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const minioPath = params.scope === "course"
    ? `materials/${params.courseId}/${materialId}/${safeName}`
    : `personal_materials/${params.userId}/${materialId}/${safeName}`;
  const previewPdfStatus = isOfficeMaterialFileType(fileType)
    ? MaterialPreviewPdfStatus.PENDING
    : MaterialPreviewPdfStatus.NA;

  const nodeReadable = params.body instanceof Readable
    ? params.body
    : Readable.fromWeb(params.body as ReadableStream<Uint8Array>);
  try {
    await putObjectStream({
      objectKey: minioPath,
      body: nodeReadable,
      contentLength: params.contentLength,
      contentType: params.contentType,
    });
  } catch (error) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Object storage upload failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  let material: { id: string; originalFilename: string; status: MaterialStatus; createdAt: Date };
  try {
    if (params.scope === "course") {
      material = await prisma.material.create({
        data: {
          id: materialId,
          courseId: params.courseId,
          lessonId: params.lessonId || null,
          originalFilename: params.originalFilename,
          fileType,
          fileSize: params.contentLength,
          minioPath,
          previewPdfStatus,
          status: MaterialStatus.UPLOADED,
        },
      });
    } else {
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
    }
  } catch (error) {
    await deleteObject(minioPath).catch(() => {});
    throw new ApiError(500, "INTERNAL_ERROR", "Failed to persist material after upload", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const task: RagQueueTask = {
    task_id: randomUUID(),
    material_id: materialId,
    operation: initialMaterialOperation(params.scope, fileType),
    created_at: new Date().toISOString(),
    text_only: params.textOnly ?? true,
  };
  try {
    await enqueueMaterialTaskWithRetry(task);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const data = {
      status: MaterialStatus.FAILED,
      statusMessage: `QUEUE_ENQUEUE_FAILED: ${detail.slice(0, 500)}`,
    };
    // An XADD timeout can still mean the worker received the task; don't overwrite its state.
    if (params.scope === "course") {
      await prisma.material.updateMany({
        where: { id: materialId, isDeleted: false, status: MaterialStatus.UPLOADED },
        data,
      });
    } else {
      await prisma.personalMaterial.updateMany({
        where: {
          id: materialId,
          userId: params.userId,
          isDeleted: false,
          status: MaterialStatus.UPLOADED,
        },
        data,
      });
    }
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Failed to queue material processing", {
      detail,
    });
  }

  return {
    id: material.id,
    original_filename: material.originalFilename,
    status: material.status,
    created_at: material.createdAt.toISOString(),
  };
}
