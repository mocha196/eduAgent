import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { listNotifications, markAllRead } from "@/lib/services/notificationService";

export const dynamic = "force-dynamic";

/** GET — list recent notifications + unread count for the current user. */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const result = await listNotifications(auth.sub);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/** PATCH — mark all notifications as read for the current user. */
export async function PATCH(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    await markAllRead(auth.sub);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
