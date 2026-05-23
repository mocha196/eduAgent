import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { assertTeacherOfCourse } from "@/lib/course-access";
import { prisma } from "@/lib/db";
import { getAssignmentAnalytics } from "@/lib/services/analyticsService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { courseId } = await ctx.params;

    if (auth.role === UserRole.ADMIN) {
      const c = await prisma.course.findFirst({
        where: { id: courseId, isDeleted: false },
      });
      if (!c) throw new ApiError(404, "NOT_FOUND", "Course not found");
    } else {
      await assertTeacherOfCourse(auth.sub, auth.role as UserRole, courseId);
    }

    const url = new URL(req.url);
    const assignmentId = url.searchParams.get("assignmentId") ?? undefined;

    const data = await getAssignmentAnalytics(courseId, assignmentId);
    return jsonOk(data);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
