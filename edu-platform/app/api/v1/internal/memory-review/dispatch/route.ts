import type { NextRequest } from "next/server";
import { DateTime } from "luxon";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { getInternalApiKeyOrNull } from "@/lib/config";
import { prisma } from "@/lib/db";
import { createDailySession } from "@/lib/services/memoryReviewService";

export const dynamic = "force-dynamic";

function requireInternalKey(req: NextRequest): void {
  const expected = getInternalApiKeyOrNull();
  if (!expected) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "INTERNAL_API_KEY is not configured");
  }
  if (req.headers.get("x-internal-key") !== expected) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid internal key");
  }
}

/**
 * POST /api/v1/internal/memory-review/dispatch
 *
 * Called by the review-scheduler every ~60s.
 * Loads all enabled preferences, checks if any user's local time matches the
 * dispatch window (= preferredTime − LEAD_MINUTES), and creates a daily session
 * for those users (idempotent).
 *
 * The lead time ensures LLM question generation completes before the user's
 * preferred notification time.
 *
 * Auth: X-Internal-Key header.
 */

/** Minutes before the user's preferred notification time to start generation. */
const DISPATCH_LEAD_MIN = parseInt(process.env.MEMORY_REVIEW_LEAD_MINUTES ?? "0", 10);

export async function POST(req: NextRequest) {
  try {
    requireInternalKey(req);

    const body = (await req.json().catch(() => ({}))) as { forceUserId?: string };

    let prefs;
    if (body.forceUserId) {
      prefs = await prisma.userMemoryReviewPreference.findMany({
        where: { userId: body.forceUserId, enabled: true },
      });
    } else {
      prefs = await prisma.userMemoryReviewPreference.findMany({
        where: { enabled: true },
      });
    }

    const now = DateTime.utc();
    const dispatched: string[] = [];
    const skipped: string[] = [];

    for (const pref of prefs) {
      try {
        const localNow = now.setZone(pref.timezone);
        const localHHmm = localNow.toFormat("HH:mm");

        // Compute the dispatch trigger time = preferredTime − LEAD_MINUTES
        const [prefHour, prefMin] = pref.localTime.split(":").map(Number);
        let preferredDT = localNow.set({ hour: prefHour, minute: prefMin, second: 0, millisecond: 0 });

        // Cross-midnight edge case: if preferred time already passed today, it's for tomorrow
        // e.g. preferred "00:10", current local "23:55" → session is for the next calendar day
        if (preferredDT.toMillis() < localNow.toMillis()) {
          preferredDT = preferredDT.plus({ days: 1 });
        }

        const dispatchDT = preferredDT.minus({ minutes: DISPATCH_LEAD_MIN });
        const dispatchHHmm = dispatchDT.toFormat("HH:mm");

        // scheduledDate = the calendar date of the user's preferred notification time
        const scheduledDate = preferredDT.toFormat("yyyy-MM-dd");

        // Only trigger if "now" (local) matches the dispatch window
        if (!body.forceUserId && localHHmm !== dispatchHHmm) {
          skipped.push(pref.userId);
          continue;
        }

        const result = await createDailySession(pref.userId, scheduledDate);
        if (result.created) {
          dispatched.push(pref.userId);
        } else {
          skipped.push(pref.userId);
        }
      } catch (err) {
        console.error(`[dispatch] Failed for userId=${pref.userId}`, err);
        skipped.push(pref.userId);
      }
    }

    return jsonOk({ dispatched: dispatched.length, skipped: skipped.length });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[internal/memory-review/dispatch]", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
