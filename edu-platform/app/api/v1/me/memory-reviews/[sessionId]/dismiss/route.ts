import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { dismissSession } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/memory-reviews/[sessionId]/dismiss
 *
 * Marks session as DISMISSED. Unanswered questions do not write mastery.
 * Questions already answered before dismiss retain their mastery updates.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { sessionId } = await params;
    await dismissSession(sessionId, auth.sub);
    return jsonOk({ dismissed: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    const err = e as Error & { statusCode?: number };
    if (err.statusCode === 404) return jsonError(new ApiError(404, "NOT_FOUND", err.message));
    console.error("[memory-reviews dismiss]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
