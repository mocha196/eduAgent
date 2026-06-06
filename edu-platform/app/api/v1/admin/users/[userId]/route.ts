import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated, requireAdmin } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/users/[userId]
//   Body: { isActive?: boolean; role?: "STUDENT" | "TEACHER" | "ADMIN" }
// ---------------------------------------------------------------------------
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const { userId } = await params;

    // Prevent admin from modifying themselves
    if (userId === auth.sub) {
      throw new ApiError(400, "VALIDATION_ERROR", "Cannot modify your own account");
    }

    const body = (await req.json()) as { isActive?: boolean; role?: string };

    const update: { isActive?: boolean; role?: UserRole } = {};

    if (typeof body.isActive === "boolean") {
      update.isActive = body.isActive;
    }
    if (body.role !== undefined) {
      const validRoles = [UserRole.STUDENT, UserRole.TEACHER, UserRole.ADMIN] as string[];
      if (!validRoles.includes(body.role)) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid role");
      }
      update.role = body.role as UserRole;
    }

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nothing to update");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    const updated = await prisma.user.update({
      where: { id: userId },
      data: update,
      select: {
        id: true,
        username: true,
        role: true,
        realName: true,
        isActive: true,
        createdAt: true,
      },
    });

    return jsonOk({ user: updated });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/users PATCH]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/users/[userId]
//   Hard-deletes a user account.
//   - Cannot delete yourself
//   - ADMIN accounts cannot be deleted
//   - Teacher accounts with owned courses cannot be deleted (archive first)
//   - Student's enrollments and submissions are cascade-deleted via transaction
// ---------------------------------------------------------------------------
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const { userId } = await params;

    if (userId === auth.sub) {
      throw new ApiError(400, "VALIDATION_ERROR", "不能删除自己的账号");
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        _count: { select: { teacherCourses: true } },
      },
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "用户不存在");

    if (user.role === UserRole.ADMIN) {
      throw new ApiError(403, "FORBIDDEN", "管理员账号不能删除");
    }

    if (user._count.teacherCourses > 0) {
      throw new ApiError(
        409,
        "CONFLICT",
        `该教师名下有 ${user._count.teacherCourses} 门课程，请先将课程删除或移交后再删除账号`,
      );
    }

    // Delete in dependency order inside a transaction
    await prisma.$transaction(async (tx) => {
      // Remove enrollment records & related submission data
      const enrollments = await tx.courseEnrollment.findMany({
        where: { studentId: userId },
        select: { id: true },
      });
      const enrollmentIds = enrollments.map((e) => e.id);

      if (enrollmentIds.length > 0) {
        // Remove submissions for those enrollments
        await tx.assignmentSubmission.deleteMany({
          where: { studentId: userId },
        });
        await tx.courseEnrollment.deleteMany({ where: { studentId: userId } });
      }

      // Remove chat/QA session data
      await tx.qaLog.deleteMany({ where: { studentId: userId } });
      await tx.courseChatSession.deleteMany({ where: { studentId: userId } });
      await tx.qaCenterSession.deleteMany({ where: { studentId: userId } });
      await tx.chatThreadTitleOverride.deleteMany({ where: { studentId: userId } });

      // Remove memory & profile data
      await tx.userMemoryFact.deleteMany({ where: { userId } });
      await tx.userMemoryConcept.deleteMany({ where: { userId } });
      await tx.userLearningProfile.deleteMany({ where: { userId } });

      // Remove personal KB sessions
      await tx.personalKbSession.deleteMany({ where: { userId } });

      // Remove notifications
      await tx.notification.deleteMany({ where: { userId } });

      // Remove refresh tokens
      await tx.refreshToken.deleteMany({ where: { userId } });

      // Finally delete the user
      await tx.user.delete({ where: { id: userId } });
    });

    return jsonOk({ deleted: true, username: user.username });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/users DELETE]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}
