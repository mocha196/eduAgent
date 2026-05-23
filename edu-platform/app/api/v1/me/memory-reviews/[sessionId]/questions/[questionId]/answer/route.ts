import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { answerQuestion } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/memory-reviews/[sessionId]/questions/[questionId]/answer
 *
 * Grades the answer immediately and updates mastery for the associated concept.
 * Returns { isCorrect, correctAnswer, explanation } so the UI can reveal the answer.
 * Returns 409 if the question was already answered (prevents double-submission score inflation).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; questionId: string }> },
) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { sessionId, questionId } = await params;
    const body = (await req.json()) as { userAnswer?: string };

    if (!body.userAnswer || typeof body.userAnswer !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", "userAnswer is required");
    }

    const result = await answerQuestion(sessionId, questionId, auth.sub, body.userAnswer);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    // Service throws plain errors with statusCode property for 404/409
    const err = e as Error & { statusCode?: number };
    if (err.statusCode === 404) return jsonError(new ApiError(404, "NOT_FOUND", err.message));
    if (err.statusCode === 409) return jsonError(new ApiError(409, "ALREADY_ANSWERED", err.message));
    console.error("[memory-reviews answer]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
