import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getMySubmission } from "@/lib/services/submissionService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string; assignmentId: string }> };

/** GET — student retrieves their own submission and grades (grading visible only after RETURNED) */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(_req));
    const { courseId, assignmentId } = await ctx.params;
    const submission = await getMySubmission(
      auth.sub,
      auth.role as UserRole,
      courseId,
      assignmentId,
    );
    return jsonOk({ submission });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
