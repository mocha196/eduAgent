import type { NextRequest } from "next/server";
import { UserRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonOk } from "@/lib/http/json-response";
import { jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated, requireAdmin, parseRoleParam } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";

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
        { email: { contains: search, mode: "insensitive" } },
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
          email: true,
          role: true,
          realName: true,
          avatarUrl: true,
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
