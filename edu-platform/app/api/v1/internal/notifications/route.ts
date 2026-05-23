import type { NextRequest } from "next/server";
import { NotificationType } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { getInternalApiKeyOrNull } from "@/lib/config";
import { prisma } from "@/lib/db";
import {
  createNotification,
  createBulkNotifications,
} from "@/lib/services/notificationService";

export const dynamic = "force-dynamic";

interface InternalNotifyBody {
  type: string;
  /** For MATERIAL_* events */
  material_id?: string;
  course_id?: string;
  /** For ASSIGNMENT_* events */
  assignment_id?: string;
  /** Teacher who owns the operation (overrides DB lookup when provided) */
  teacher_id?: string;
  /** Extra context passed through to notification metadata */
  extra?: Record<string, unknown>;
}

function requireInternalKey(req: NextRequest): void {
  const expected = getInternalApiKeyOrNull();
  if (!expected) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "INTERNAL_API_KEY is not configured");
  }
  if (req.headers.get("x-internal-key") !== expected) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid internal key");
  }
}

/**
 * POST /api/v1/internal/notifications
 *
 * Called by the Python RAG service after:
 *   - material processing → READY  (type: MATERIAL_READY)
 *   - assignment generation → DRAFT (type: ASSIGNMENT_GENERATED)
 *   - assignment generation → FAILED (type: ASSIGNMENT_FAILED)
 *
 * Auth: X-Internal-Key header (same key as other internal routes).
 */
export async function POST(req: NextRequest) {
  try {
    requireInternalKey(req);
    const body = (await req.json()) as InternalNotifyBody;
    const type = body.type as NotificationType;

    if (!Object.values(NotificationType).includes(type)) {
      throw new ApiError(400, "VALIDATION_ERROR", `Unknown notification type: ${body.type}`);
    }

    switch (type) {
      case NotificationType.MATERIAL_READY: {
        if (!body.material_id || !body.course_id) {
          throw new ApiError(400, "VALIDATION_ERROR", "material_id and course_id are required");
        }
        const material = await prisma.material.findFirst({
          where: { id: body.material_id },
          select: { originalFilename: true, courseId: true, course: { select: { teacherId: true, name: true } } },
        });
        if (!material) throw new ApiError(404, "NOT_FOUND", "Material not found");

        const enrollments = await prisma.courseEnrollment.findMany({
          where: { courseId: material.courseId },
          select: { studentId: true },
        });
        const studentIds = enrollments.map((e) => e.studentId);
        const allUserIds = [material.course.teacherId, ...studentIds];

        await createBulkNotifications({
          userIds: allUserIds,
          type: NotificationType.MATERIAL_READY,
          title: "课件已就绪",
          body: `《${material.originalFilename}》已完成处理，可以开始学习了。`,
          metadata: {
            courseId: material.courseId,
            materialId: body.material_id,
            courseName: material.course.name,
            ...(body.extra ?? {}),
          },
        });
        break;
      }

      case NotificationType.ASSIGNMENT_GENERATED:
      case NotificationType.ASSIGNMENT_FAILED: {
        if (!body.assignment_id) {
          throw new ApiError(400, "VALIDATION_ERROR", "assignment_id is required");
        }
        const assignment = await prisma.assignment.findFirst({
          where: { id: body.assignment_id },
          select: {
            title: true,
            courseId: true,
            createdBy: true,
            course: { select: { name: true } },
          },
        });
        if (!assignment) throw new ApiError(404, "NOT_FOUND", "Assignment not found");

        const teacherId = body.teacher_id ?? assignment.createdBy;
        const isSuccess = type === NotificationType.ASSIGNMENT_GENERATED;

        await createNotification({
          userId: teacherId,
          type,
          title: isSuccess ? "作业生成完成" : "作业生成失败",
          body: isSuccess
            ? `《${assignment.title}》已生成完毕，请检查后发布。`
            : `《${assignment.title}》生成失败，请重试或调整参数。`,
          metadata: {
            courseId: assignment.courseId,
            assignmentId: body.assignment_id,
            courseName: assignment.course.name,
            ...(body.extra ?? {}),
          },
        });
        break;
      }

      default:
        throw new ApiError(400, "VALIDATION_ERROR", `Type ${type} is not supported for internal push`);
    }

    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
