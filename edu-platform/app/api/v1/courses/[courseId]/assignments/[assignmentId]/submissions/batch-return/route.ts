import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { batchReturnSubmissions } from "@/lib/services/submissionService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string; assignmentId: string }> };

/** POST — teacher batch-returns all GRADED submissions for this assignment */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(_req));
    const { courseId, assignmentId } = await ctx.params;
    const result = await batchReturnSubmissions(
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
