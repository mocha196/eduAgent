/**
 * Unit tests for the memory-review scheduler timezone + lead-time logic.
 *
 * The dispatch endpoint triggers at (preferredTime − LEAD_MINUTES) in the user's
 * timezone. These tests validate that:
 *  - The dispatch window is computed correctly across timezones
 *  - The `scheduledDate` is set to the preferred notification date (not the dispatch date)
 */

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";

const LEAD_MIN = 15;

// ---------------------------------------------------------------------------
// Helpers — mirror the logic in dispatch/route.ts
// ---------------------------------------------------------------------------

function computeDispatch(utcIsoString: string, tz: string, localTime: string) {
  const now = DateTime.fromISO(utcIsoString, { zone: "utc" });
  const localNow = now.setZone(tz);
  const localHHmm = localNow.toFormat("HH:mm");

  const [prefHour, prefMin] = localTime.split(":").map(Number);
  let preferredDT = localNow.set({ hour: prefHour, minute: prefMin, second: 0, millisecond: 0 });

  // Cross-midnight: if preferred time has already passed today, it's for tomorrow
  if (preferredDT.toMillis() < localNow.toMillis()) {
    preferredDT = preferredDT.plus({ days: 1 });
  }

  const dispatchDT = preferredDT.minus({ minutes: LEAD_MIN });
  const dispatchHHmm = dispatchDT.toFormat("HH:mm");
  const scheduledDate = preferredDT.toFormat("yyyy-MM-dd");

  const shouldDispatch = localHHmm === dispatchHHmm;
  return { localHHmm, dispatchHHmm, scheduledDate, shouldDispatch };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Review scheduler timezone + lead-time boundary", () => {
  const SHANGHAI_TZ = "Asia/Shanghai";
  const NY_TZ = "America/New_York";
  const LONDON_TZ = "Europe/London";

  // preferredTime = 09:00 → dispatch at 08:45 local
  // Asia/Shanghai = UTC+8 → dispatch UTC = 00:45
  it("dispatches at 08:45 local (UTC 00:45) for Asia/Shanghai user with 09:00 preference", () => {
    const { shouldDispatch, dispatchHHmm, scheduledDate } =
      computeDispatch("2026-05-23T00:45:00.000Z", SHANGHAI_TZ, "09:00");
    expect(dispatchHHmm).toBe("08:45");
    expect(shouldDispatch).toBe(true);
    expect(scheduledDate).toBe("2026-05-23");
  });

  it("does NOT dispatch at 09:00 local (UTC 01:00) — that is 15 min after dispatch window", () => {
    const { shouldDispatch } = computeDispatch("2026-05-23T01:00:00.000Z", SHANGHAI_TZ, "09:00");
    expect(shouldDispatch).toBe(false);
  });

  it("does NOT dispatch at 08:44 local — one minute before window", () => {
    const { shouldDispatch } = computeDispatch("2026-05-23T00:44:00.000Z", SHANGHAI_TZ, "09:00");
    expect(shouldDispatch).toBe(false);
  });

  it("scheduledDate is the preferred notification date, not the dispatch date", () => {
    // Edge case: preferred 00:10 → dispatch at 23:55 (previous day)
    const { dispatchHHmm, scheduledDate } =
      computeDispatch("2026-05-22T15:55:00.000Z", SHANGHAI_TZ, "00:10");
    // 15:55 UTC = 23:55 Asia/Shanghai
    expect(dispatchHHmm).toBe("23:55");
    // scheduledDate should be the NEXT day (the notification date 00:10 May 23)
    expect(scheduledDate).toBe("2026-05-23");
  });

  it("dispatches at 12:45 UTC for America/New_York user with 09:00 preference (EDT = UTC-4)", () => {
    // 09:00 EDT = 13:00 UTC → dispatch at 08:45 EDT = 12:45 UTC
    const { shouldDispatch, dispatchHHmm } =
      computeDispatch("2026-05-23T12:45:00.000Z", NY_TZ, "09:00");
    expect(dispatchHHmm).toBe("08:45");
    expect(shouldDispatch).toBe(true);
  });

  it("dispatches at 07:45 UTC for Europe/London user with 09:00 preference (BST = UTC+1)", () => {
    // 09:00 BST = 08:00 UTC → dispatch at 08:45 BST = 07:45 UTC
    const { shouldDispatch, dispatchHHmm } =
      computeDispatch("2026-05-23T07:45:00.000Z", LONDON_TZ, "09:00");
    expect(dispatchHHmm).toBe("08:45");
    expect(shouldDispatch).toBe(true);
  });

  it("dispatches correctly for early morning (00:30) preference", () => {
    // 00:30 Asia/Shanghai → dispatch at 00:15 local → UTC 16:15 (prev day)
    const { shouldDispatch, dispatchHHmm, scheduledDate } =
      computeDispatch("2026-05-22T16:15:00.000Z", SHANGHAI_TZ, "00:30");
    expect(dispatchHHmm).toBe("00:15");
    expect(shouldDispatch).toBe(true);
    expect(scheduledDate).toBe("2026-05-23");
  });
});

// ---------------------------------------------------------------------------
// Scheduler minute granularity
// ---------------------------------------------------------------------------

describe("Scheduler minute granularity", () => {
  it("matches at any second within the dispatch minute", () => {
    const at00 = computeDispatch("2026-05-23T00:45:00.000Z", "Asia/Shanghai", "09:00");
    const at30 = computeDispatch("2026-05-23T00:45:30.000Z", "Asia/Shanghai", "09:00");
    const at59 = computeDispatch("2026-05-23T00:45:59.000Z", "Asia/Shanghai", "09:00");
    expect(at00.shouldDispatch).toBe(true);
    expect(at30.shouldDispatch).toBe(true);
    expect(at59.shouldDispatch).toBe(true);
  });

  it("does not match the minute before or after the dispatch window", () => {
    const before = computeDispatch("2026-05-23T00:44:59.000Z", "Asia/Shanghai", "09:00");
    const after = computeDispatch("2026-05-23T00:46:00.000Z", "Asia/Shanghai", "09:00");
    expect(before.shouldDispatch).toBe(false);
    expect(after.shouldDispatch).toBe(false);
  });
});
