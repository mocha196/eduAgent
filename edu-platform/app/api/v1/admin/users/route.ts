import type { NextRequest } from "next/server";
import { UserRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonOk } from "@/lib/http/json-response";
import { jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated, requireAdmin, parseRoleParam } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { createUserByAdmin } from "@/lib/services/authService";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users
//   ?role=STUDENT|TEACHER|ADMIN
//   &search=<username or email or realName>
//   &page=<number, 1-based>
//   &isActive=true|false
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const sp = req.nextUrl.searchParams;
    const roleParam = sp.get("role");
    const search = sp.get("search")?.trim() ?? "";
    const isActiveParam = sp.get("isActive");
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));

    const where: Prisma.UserWhereInput = {};

    if (roleParam) {
      where.role = parseRoleParam(roleParam);
    }
    if (isActiveParam !== null) {
      where.isActive = isActiveParam !== "false";
    }
    if (search) {
      where.OR = [
        { username: { contains: search, mode: "insensitive" } },
        { realName: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          role: true,
          realName: true,
          isActive: true,
          createdAt: true,
          _count: {
            select: {
              courseEnrollments: true,
              teacherCourses: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);

    return jsonOk({
      users,
      pagination: {
        total,
        page,
        pageSize: PAGE_SIZE,
        totalPages: Math.ceil(total / PAGE_SIZE),
      },
    });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/users GET]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users  — 管理员创建账号
//   Body: { username, realName?, role? }
//   username 即学号，初始密码与学号相同
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const body = (await req.json()) as {
      username?: string;
      realName?: string;
      role?: string;
    };

    const username = typeof body.username === "string" ? body.username.trim() : "";

    if (!username) {
      throw new ApiError(400, "VALIDATION_ERROR", "学号不能为空");
    }

    const role = parseRoleParam(body.role ?? "STUDENT");
    if (role === UserRole.ADMIN) {
      throw new ApiError(403, "FORBIDDEN", "不允许创建管理员账号");
    }

    const result = await createUserByAdmin({
      username,
      password: username, // 初始密码与学号相同
      role,
      realName: typeof body.realName === "string" ? body.realName.trim() || null : null,
    });

    return jsonOk({ user: result.user, initial_password: username }, 201);
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/users POST]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}
