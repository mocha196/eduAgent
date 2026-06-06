import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { startSessionOnDemand } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/memory-reviews/start
 *
 * Manually starts (or resumes) a review session for the authenticated user.
 * No body required.
 *
 * Response:
 *   { status: "active",    session: PendingSessionDto }
 *   { status: "completed"                             }  ← already done today
 *   { status: "no_concepts"                           }  ← nothing to review yet
 */
export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const result = await startSessionOnDemand(auth.sub);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[memory-reviews/start]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Failed to start review session"));
  }
}
