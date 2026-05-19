import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getSubmissionDetail, overrideGrades } from "@/lib/services/submissionService";
import type { OverrideGradesBody } from "@/lib/dto/submission.dto";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string; assignmentId: string; submissionId: string }> };

/** GET — teacher views full submission detail */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(_req));
    const { courseId, assignmentId, submissionId } = await ctx.params;
    const submission = await getSubmissionDetail(
      auth.sub,
      auth.role as UserRole,
      courseId,
      assignmentId,
      submissionId,
    );
    return jsonOk({ submission });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/** PATCH — teacher overrides AI grades and/or sets overall feedback */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { courseId, assignmentId, submissionId } = await ctx.params;
    const body = (await req.json()) as OverrideGradesBody;
    const submission = await overrideGrades(
      auth.sub,
      auth.role as UserRole,
      courseId,
      assignmentId,
      submissionId,
      body,
    );
    return jsonOk({ submission });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
