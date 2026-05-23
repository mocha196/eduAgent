import type { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated, requireAdmin } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/users/[userId]
//   Body: { isActive?: boolean; role?: "STUDENT" | "TEACHER" | "ADMIN" }
// ---------------------------------------------------------------------------
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    requireAdmin(auth);

    const { userId } = await params;

    // Prevent admin from modifying themselves
    if (userId === auth.sub) {
      throw new ApiError(400, "VALIDATION_ERROR", "Cannot modify your own account");
    }

    const body = (await req.json()) as { isActive?: boolean; role?: string };

    const update: { isActive?: boolean; role?: UserRole } = {};

    if (typeof body.isActive === "boolean") {
      update.isActive = body.isActive;
    }
    if (body.role !== undefined) {
      const validRoles = [UserRole.STUDENT, UserRole.TEACHER, UserRole.ADMIN] as string[];
      if (!validRoles.includes(body.role)) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid role");
      }
      update.role = body.role as UserRole;
    }

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nothing to update");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    const updated = await prisma.user.update({
      where: { id: userId },
      data: update,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        realName: true,
        isActive: true,
        createdAt: true,
      },
    });

    return jsonOk({ user: updated });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    console.error("[admin/users PATCH]", err);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Server error"));
  }
}
