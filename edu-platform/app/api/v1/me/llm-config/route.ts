import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import {
  loadUserLlmConfig,
  saveUserLlmConfig,
  maskConfig,
  ALL_ROLES,
  type UserLlmConfig,
  type LLMRoleKey,
} from "@/lib/agent/user-llm-store";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/llm-config — returns masked config (no plaintext keys). */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const config = await loadUserLlmConfig(auth.sub);
    return jsonOk({ config: maskConfig(config) });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

type RoleBody = { apiKey?: string; baseURL?: string; model?: string };
type PutBody = Partial<Record<LLMRoleKey, RoleBody>>;

/** PUT /api/v1/me/llm-config — saves config for all 5 roles. */
export async function PUT(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));

    let body: PutBody;
    try {
      body = (await req.json()) as PutBody;
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid JSON body");
    }

    // Build incoming config — only accept known roles; strip unknown fields
    const incoming: UserLlmConfig = {};
    for (const role of ALL_ROLES) {
      const rc = body[role];
      if (!rc || typeof rc !== "object") continue;
      incoming[role] = {
        apiKey: typeof rc.apiKey === "string" ? rc.apiKey : undefined,
        baseURL: typeof rc.baseURL === "string" ? rc.baseURL : undefined,
        model: typeof rc.model === "string" ? rc.model : undefined,
      };
    }

    await saveUserLlmConfig(auth.sub, incoming);

    // Return the saved config in masked form
    const saved = await loadUserLlmConfig(auth.sub);
    return jsonOk({ config: maskConfig(saved) });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/** DELETE /api/v1/me/llm-config — clears all user LLM overrides. */
export async function DELETE(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    // Save an empty config to clear all roles
    await saveUserLlmConfig(auth.sub, {});
    return jsonOk({ cleared: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
