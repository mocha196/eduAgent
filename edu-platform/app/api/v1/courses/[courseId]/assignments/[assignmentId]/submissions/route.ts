import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import {
  listSubmissionsForTeacher,
  submitAssignment,
} from "@/lib/services/submissionService";
import type { SubmitAssignmentBody } from "@/lib/dto/submission.dto";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string; assignmentId: string }> };

/** GET — teacher: list all submissions; students use /mine instead */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(_req));
    const { courseId, assignmentId } = await ctx.params;
    const result = await listSubmissionsForTeacher(
      auth.sub,
      auth.role as UserRole,
      courseId,
      assignmentId,
    );
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/** POST — student submits answers */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { courseId, assignmentId } = await ctx.params;
    const body = (await req.json()) as SubmitAssignmentBody;
    const submission = await submitAssignment(
      auth.sub,
      auth.role as UserRole,
      courseId,
      assignmentId,
      body,
    );
    return jsonOk({ submission }, 201);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
