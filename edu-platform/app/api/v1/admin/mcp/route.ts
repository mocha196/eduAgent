import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jsonOk } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { McpManager, readConfig, writeConfig } from "@/lib/agent/mcp-manager";
import type { McpServerConfig, McpTransport } from "@/lib/agent/mcp-manager";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"];

function validateServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "VALIDATION_ERROR", "servers must be an array");
  if (raw.length > 10) throw new ApiError(400, "VALIDATION_ERROR", "maximum 10 MCP servers allowed");

  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null)
      throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}] must be an object`);

    const obj = item as Record<string, unknown>;

    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id || !/^[a-z0-9_-]+$/i.test(id) || id.length > 32)
      throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].id must be 1–32 alphanumeric/dash/underscore chars`);

    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!label || label.length > 50)
      throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].label must be 1–50 characters`);

    const transport = obj.transport as string;
    if (!VALID_TRANSPORTS.includes(transport as McpTransport))
      throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].transport must be one of: ${VALID_TRANSPORTS.join(", ")}`);

    const cfg: McpServerConfig = {
      id,
      label,
      enabled: obj.enabled !== false,
      transport: transport as McpTransport,
    };

    if (transport === "stdio") {
      if (typeof obj.command !== "string" || !obj.command.trim())
        throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].command is required for stdio transport`);
      cfg.command = obj.command.trim();
      if (Array.isArray(obj.args)) cfg.args = obj.args.map(String);
      if (typeof obj.env === "object" && obj.env !== null) {
        cfg.env = Object.fromEntries(
          Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
      if (typeof obj.cwd === "string") cfg.cwd = obj.cwd;
    } else {
      // sse or http
      if (typeof obj.url !== "string" || !obj.url.trim())
        throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].url is required for ${transport} transport`);
      try {
        new URL(obj.url);
      } catch {
        throw new ApiError(400, "VALIDATION_ERROR", `servers[${i}].url is not a valid URL`);
      }
      cfg.url = obj.url.trim();
      if (typeof obj.headers === "object" && obj.headers !== null) {
        cfg.headers = Object.fromEntries(
          Object.entries(obj.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    }

    return cfg;
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/mcp — return current server list
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");
    return jsonOk({ servers: readConfig() });
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json(e.toBody(), { status: e.status });
    console.error("[GET /admin/mcp]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/mcp — overwrite server list and reconnect
// ---------------------------------------------------------------------------
export async function PUT(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");

    const body = (await req.json()) as { servers?: unknown };
    const servers = validateServers(body.servers);

    writeConfig(servers);

    // Reset singleton so next getTools() call reconnects with new config
    await McpManager.getInstance().reset();

    return jsonOk({ servers });
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json(e.toBody(), { status: e.status });
    console.error("[PUT /admin/mcp]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
