import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jsonOk } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { McpManager, readConfig } from "@/lib/agent/mcp-manager";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/mcp/test
 * Body: { serverId: string }
 *
 * Attempts a one-shot connection to the specified server from mcp.config.json,
 * lists its tools, then disconnects. Returns { ok, tools, error }.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");

    const { serverId } = (await req.json()) as { serverId?: string };
    if (!serverId || typeof serverId !== "string")
      throw new ApiError(400, "VALIDATION_ERROR", "serverId is required");

    const servers = readConfig();
    const cfg = servers.find((s) => s.id === serverId);
    if (!cfg) throw new ApiError(404, "NOT_FOUND", `Server "${serverId}" not found in mcp.config.json`);

    try {
      const { tools } = await McpManager.getInstance().testServer(cfg);
      return jsonOk({ ok: true, tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonOk({ ok: false, tools: [], error: message });
    }
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json(e.toBody(), { status: e.status });
    console.error("[POST /admin/mcp/test]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
