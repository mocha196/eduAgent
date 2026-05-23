import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { UserRole } from "@prisma/client";
import { suggestFeedback } from "@/lib/services/feedbackSuggestService";
import { runWithUserLlm } from "@/lib/agent/user-llm-store";
import type { SuggestFeedbackBody } from "@/lib/dto/submission.dto";

export const dynamic = "force-dynamic";

/** POST — teacher requests an AI suggestion to continue their feedback text (ghost text) */
export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== UserRole.TEACHER) {
      throw new ApiError(403, "FORBIDDEN", "Teacher role required");
    }
    const body = (await req.json()) as SuggestFeedbackBody;
    if (typeof body.questionText !== "string" || typeof body.studentAnswer !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", "questionText and studentAnswer are required");
    }
    const result = await runWithUserLlm(auth.sub, () => suggestFeedback(body));
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[suggest-feedback]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Feedback suggestion failed"));
  }
}
