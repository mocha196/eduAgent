import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getPersonalKbThreadMessages } from "@/lib/services/personalKbThreadService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { sessionId } = await ctx.params;
    const decoded = decodeURIComponent(sessionId);
    const messages = await getPersonalKbThreadMessages(auth.sub, decoded);
    return jsonOk({ messages });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
