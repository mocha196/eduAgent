import type { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getOrCreatePreference, updatePreference } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/memory-reviews/preferences */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const pref = await getOrCreatePreference(auth.sub);
    return jsonOk({ preference: pref });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[memory-reviews/preferences GET]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

/** PUT /api/v1/me/memory-reviews/preferences */
export async function PUT(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const body = (await req.json()) as {
      enabled?: boolean;
      localTime?: string;
      timezone?: string;
    };

    // Validate localTime format HH:mm
    if (body.localTime !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(body.localTime)) {
        throw new ApiError(400, "VALIDATION_ERROR", "localTime must be in HH:mm format");
      }
    }
    // Validate timezone is a non-empty string (full IANA validation not done server-side)
    if (body.timezone !== undefined && (!body.timezone || body.timezone.length > 64)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid timezone string");
    }

    const pref = await updatePreference(auth.sub, {
      enabled: body.enabled,
      localTime: body.localTime,
      timezone: body.timezone,
    });
    return jsonOk({ preference: pref });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[memory-reviews/preferences PUT]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
