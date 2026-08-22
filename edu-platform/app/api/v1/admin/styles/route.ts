import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const NAME_RE = /^[\w\-\u4e00-\u9fa5]{1,50}$/u;

function requireAdmin(req: NextRequest) {
  return getAuthFromRequest(req).then((auth) => {
    const a = requireAuthenticated(auth);
    if (a.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");
    return a;
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/styles — list all styles
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const styles = await prisma.agentStyle.findMany({ orderBy: { createdAt: "asc" } });
    return jsonOk({ styles });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/styles — create new style
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);

    const body = (await req.json()) as Record<string, unknown>;
    const name = (body.name as string | undefined)?.trim() ?? "";
    const description = ((body.description as string | undefined) ?? "").trim();
    const styleBody = ((body.body as string | undefined) ?? "").trim();
    const alwaysInject = body.alwaysInject === true;
    const enabled = body.enabled !== false;

    if (!NAME_RE.test(name))
      throw new ApiError(400, "VALIDATION_ERROR", "名称只能包含字母、数字、下划线、连字符、中文，1–50 个字符");
    if (!styleBody)
      throw new ApiError(400, "VALIDATION_ERROR", "角色定义不能为空");

    const existing = await prisma.agentStyle.findUnique({ where: { name } });
    if (existing) throw new ApiError(409, "CONFLICT", `风格名称 "${name}" 已存在`);

    const style = await prisma.agentStyle.create({
      data: { name, description, body: styleBody, alwaysInject, enabled, isBuiltIn: false },
    });
    return jsonOk({ style }, 201);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    throw e;
  }
}
