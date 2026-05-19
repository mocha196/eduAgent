import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { assertTeacherOfCourse, assertUuid } from "@/lib/course-access";
import { triggerGrading } from "@/lib/services/submissionService";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string; assignmentId: string; submissionId: string }> };

/** POST — teacher manually triggers (or re-triggers) AI grading for a submission */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(_req));
    const { courseId, assignmentId, submissionId } = await ctx.params;

    assertUuid(submissionId, "submission_id");
    await assertTeacherOfCourse(auth.sub, auth.role as UserRole, courseId);

    const submission = await prisma.assignmentSubmission.findFirst({
      where: { id: submissionId, assignmentId },
    });
    if (!submission) throw new ApiError(404, "NOT_FOUND", "Submission not found");

    // Run grading synchronously so the teacher sees an immediate result
    await triggerGrading(submissionId);

    const updated = await prisma.assignmentSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { student: { select: { realName: true, username: true } } },
    });
    return jsonOk({ submission: updated });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
