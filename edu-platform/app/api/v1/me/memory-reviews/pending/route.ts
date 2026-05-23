import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getPendingSession } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/memory-reviews/pending
 * Returns the current in-progress/pending review session (if any).
 * Questions are returned WITHOUT answer/explanation fields (revealed only on /answer).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const session = await getPendingSession(auth.sub);
    return jsonOk({ session });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[memory-reviews/pending]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
