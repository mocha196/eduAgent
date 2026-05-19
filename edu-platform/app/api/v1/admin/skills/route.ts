import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { jsonOk } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { resetSkillsLoader } from "@/lib/agent/skills-loader";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(process.cwd(), "skills.config.json");

type SourceInput = {
  path: string;
  label: string;
  enabled: boolean;
};

function readConfig(): SourceInput[] {
  if (!fs.existsSync(CONFIG_PATH)) {
    return [{ path: "../skills", label: "built-in", enabled: true }];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as {
      sources?: SourceInput[];
    };
    return parsed.sources ?? [];
  } catch {
    return [];
  }
}

function validateSources(raw: unknown): SourceInput[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "VALIDATION_ERROR", "sources must be an array");
  if (raw.length > 20) throw new ApiError(400, "VALIDATION_ERROR", "maximum 20 sources allowed");
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null)
      throw new ApiError(400, "VALIDATION_ERROR", `sources[${i}] must be an object`);
    const { path: p, label, enabled } = item as Record<string, unknown>;
    if (typeof p !== "string" || !p.trim())
      throw new ApiError(400, "VALIDATION_ERROR", `sources[${i}].path is required`);
    if (typeof label !== "string" || !label.trim() || label.trim().length > 50)
      throw new ApiError(400, "VALIDATION_ERROR", `sources[${i}].label must be 1–50 characters`);
    return {
      path: p.trim(),
      label: label.trim(),
      enabled: enabled !== false,
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/skills — return current skill sources
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");
    return jsonOk({ sources: readConfig() });
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json(e.toBody(), { status: e.status });
    console.error("[GET /admin/skills]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/skills — overwrite skill sources and reload the singleton
// ---------------------------------------------------------------------------
export async function PUT(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");

    const body = (await req.json()) as { sources?: unknown };
    const sources = validateSources(body.sources);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ sources }, null, 2), "utf-8");

    // Invalidate the in-process singleton so the next request picks up the new config
    resetSkillsLoader();

    return jsonOk({ sources });
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json(e.toBody(), { status: e.status });
    console.error("[PUT /admin/skills]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
