import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getOrCreatePersonalKbSession, createPersonalKbSession } from "@/lib/services/personalMaterialService";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const session = await getOrCreatePersonalKbSession(auth.sub);
    return jsonOk(session);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const session = await createPersonalKbSession(auth.sub);
    return jsonOk(session);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
