import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated, requireAdmin } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const SORT_FIELDS = ["enrollments", "lessons", "materials", "createdAt"] as const;

type SortField = (typeof SORT_FIELDS)[number];
type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/courses
//   &search=<course name>
//   &teacher=<teacher username or realName>
//   &page=<number, 1-based>
//   &sortBy=enrollments|lessons|materials|createdAt
//   &sortDir=asc|desc
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const sp = req.nextUrl.searchParams;
    const search = sp.get("search")?.trim() ?? "";
    const teacherSearch = sp.get("teacher")?.trim() ?? "";
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
    const sortByParam = sp.get("sortBy") ?? "createdAt";
    const sortDirParam = sp.get("sortDir") ?? "desc";

    if (!SORT_FIELDS.includes(sortByParam as SortField)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid sort field");
    }
    if (sortDirParam !== "asc" && sortDirParam !== "desc") {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid sort direction");
    }

    const sortBy = sortByParam as SortField;
    const sortDir = sortDirParam as SortDir;

    const where: Prisma.CourseWhereInput = {
      isDeleted: false,
    };

    if (search) {
      where.name = { contains: search, mode: "insensitive" };
    }
    if (teacherSearch) {
      where.teacher = {
        OR: [
          { username: { contains: teacherSearch, mode: "insensitive" } },
          { realName: { contains: teacherSearch, mode: "insensitive" } },
        ],
      };
    }

    const orderBy: Prisma.CourseOrderByWithRelationInput =
      sortBy === "enrollments"
        ? { enrollments: { _count: sortDir } }
        : sortBy === "lessons"
          ? { lessons: { _count: sortDir } }
          : sortBy === "materials"
            ? { materials: { _count: sortDir } }
            : { createdAt: sortDir };

    const [total, courses] = await Promise.all([
      prisma.course.count({ where }),
      prisma.course.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          teacher: {
            select: {
              id: true,
              username: true,
              realName: true,
            },
          },
          _count: {
            select: {
              enrollments: true,
              lessons: true,
              materials: true,
            },
          },
        },
        orderBy,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);

    return jsonOk({
      courses,
      pagination: {
        total,
        page,
        pageSize: PAGE_SIZE,
        totalPages: Math.ceil(total / PAGE_SIZE),
      },
    });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/courses GET]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}
