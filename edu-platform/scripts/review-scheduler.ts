/**
 * review-scheduler — Standalone Node.js process that triggers daily memory reviews.
 *
 * Runs as a separate Docker service (same image, different command).
 * Every 60 seconds it calls the internal dispatch endpoint, which checks each
 * user's timezone-aware local time and creates a session if the time matches.
 *
 * Usage: npx tsx scripts/review-scheduler.ts
 */

const DISPATCH_URL =
  process.env.NEXTJS_INTERNAL_URL
    ? `${process.env.NEXTJS_INTERNAL_URL}/api/v1/internal/memory-review/dispatch`
    : "http://nextjs:3000/api/v1/internal/memory-review/dispatch";

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";
const TICK_INTERVAL_MS = 60_000; // 1 minute

async function tick(): Promise<void> {
  try {
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_KEY,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as { dispatched: number; skipped: number };
    if (data.dispatched > 0) {
      console.log(`[review-scheduler] ${new Date().toISOString()} dispatched=${data.dispatched} skipped=${data.skipped}`);
    }
  } catch (err) {
    console.error(`[review-scheduler] tick error:`, err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  console.log(`[review-scheduler] starting, dispatch URL: ${DISPATCH_URL}`);
  // Initial tick on startup (in case of restart during scheduled window)
  await tick();
  // Schedule recurring ticks
  setInterval(() => void tick(), TICK_INTERVAL_MS);
}

void main();
