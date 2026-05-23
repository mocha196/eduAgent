import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const NAME_RE = /^[\w\-\u4e00-\u9fa5]{1,50}$/u;

async function requireAdmin(req: NextRequest) {
  const auth = requireAuthenticated(await getAuthFromRequest(req));
  if (auth.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");
  return auth;
}

async function getStyle(id: string) {
  const style = await prisma.agentStyle.findUnique({ where: { id } });
  if (!style) throw new ApiError(404, "NOT_FOUND", "风格不存在");
  return style;
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/styles/[styleId]
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, { params }: { params: Promise<{ styleId: string }> }) {
  try {
    await requireAdmin(req);
    const { styleId } = await params;
    const style = await getStyle(styleId);
    return jsonOk({ style });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/styles/[styleId]
// ---------------------------------------------------------------------------
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ styleId: string }> }) {
  try {
    await requireAdmin(req);
    const { styleId } = await params;
    const style = await getStyle(styleId);

    const body = (await req.json()) as Record<string, unknown>;

    // Build update payload — ignore isBuiltIn (never allow changing)
    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = (body.name as string).trim();
      if (!NAME_RE.test(name))
        throw new ApiError(400, "VALIDATION_ERROR", "名称格式不合法");
      if (name !== style.name) {
        const conflict = await prisma.agentStyle.findUnique({ where: { name } });
        if (conflict) throw new ApiError(409, "CONFLICT", `名称 "${name}" 已被占用`);
      }
      // Built-in styles cannot be renamed
      if (style.isBuiltIn && name !== style.name)
        throw new ApiError(403, "FORBIDDEN", "内置风格不可重命名");
      data.name = name;
    }
    if (body.description !== undefined) data.description = (body.description as string).trim();
    if (body.body !== undefined) {
      const b = (body.body as string).trim();
      if (!b) throw new ApiError(400, "VALIDATION_ERROR", "角色定义不能为空");
      data.body = b;
    }
    if (body.alwaysInject !== undefined) data.alwaysInject = body.alwaysInject === true;
    if (body.enabled !== undefined) data.enabled = body.enabled !== false;

    const updated = await prisma.agentStyle.update({ where: { id: styleId }, data });
    return jsonOk({ style: updated });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/styles/[styleId]
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ styleId: string }> }) {
  try {
    await requireAdmin(req);
    const { styleId } = await params;
    const style = await getStyle(styleId);

    if (style.isBuiltIn)
      throw new ApiError(403, "FORBIDDEN", "内置风格不可删除，可将其禁用");

    await prisma.agentStyle.delete({ where: { id: styleId } });
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    throw e;
  }
}
