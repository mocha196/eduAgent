import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/me/memories/facts/[id]
 * Deletes a single memory fact belonging to the authenticated user.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const { id } = await ctx.params;

    const fact = await prisma.userMemoryFact.findUnique({ where: { id } });
    if (!fact || fact.userId !== auth.sub) {
      throw new ApiError(404, "NOT_FOUND", "Memory fact not found");
    }

    await prisma.userMemoryFact.delete({ where: { id } });
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
