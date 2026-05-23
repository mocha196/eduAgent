import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { UserRole } from "@prisma/client";
import { suggestQuestion } from "@/lib/services/questionSuggestService";
import { runWithUserLlm } from "@/lib/agent/user-llm-store";
import type { SuggestQuestionBody } from "@/lib/dto/assignment.dto";

export const dynamic = "force-dynamic";

/** POST — ghost-text AI suggestion for a custom question field (stem or explanation). */
export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== UserRole.TEACHER) {
      throw new ApiError(403, "FORBIDDEN", "Teacher role required");
    }
    const body = (await req.json()) as SuggestQuestionBody;
    if (!body.field || !body.qType || !body.entityName || typeof body.prefix !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", "field, qType, entityName, and prefix are required");
    }
    const result = await runWithUserLlm(auth.sub, () => suggestQuestion(body));
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[suggest-question]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Question suggestion failed"));
  }
}
