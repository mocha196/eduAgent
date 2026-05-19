import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { cancelPersonalMaterial } from "@/lib/services/personalMaterialService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ materialId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { materialId } = await ctx.params;
    await cancelPersonalMaterial(auth.sub, materialId);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
