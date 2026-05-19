import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import {
  getPersonalMaterial,
  deletePersonalMaterial,
} from "@/lib/services/personalMaterialService";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ materialId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { materialId } = await ctx.params;
    const detail = await getPersonalMaterial(auth.sub, materialId);
    return jsonOk(detail);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { materialId } = await ctx.params;
    await deletePersonalMaterial(auth.sub, materialId);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
