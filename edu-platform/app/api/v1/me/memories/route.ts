import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/memories
 * Returns all long-term memory facts and concepts for the authenticated user.
 * Query params: limit (default 200, max 500)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);

    const [facts, concepts] = await Promise.all([
      prisma.userMemoryFact.findMany({
        where: { userId: auth.sub },
        orderBy: { timestamp: "desc" },
        take: limit,
        select: {
          id: true,
          category: true,
          content: true,
          confidence: true,
          timestamp: true,
          sessionId: true,
        },
      }),
      prisma.userMemoryConcept.findMany({
        where: { userId: auth.sub },
        orderBy: { lastUpdated: "desc" },
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          masteryLevel: true,
          lastUpdated: true,
        },
      }),
    ]);

    return jsonOk({ facts, concepts });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/**
 * DELETE /api/v1/me/memories
 * Deletes ALL memory facts and concepts for the authenticated user.
 */
export async function DELETE(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));

    const [factsResult, conceptsResult] = await prisma.$transaction([
      prisma.userMemoryFact.deleteMany({ where: { userId: auth.sub } }),
      prisma.userMemoryConcept.deleteMany({ where: { userId: auth.sub } }),
    ]);

    return jsonOk({
      deleted_facts: factsResult.count,
      deleted_concepts: conceptsResult.count,
    });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
