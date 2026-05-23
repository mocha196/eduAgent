import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/http/api-error";
import { jsonError } from "@/lib/http/json-response";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getRedis } from "@/lib/redis";
import { notifChannel } from "@/lib/redis-pubsub";

export const dynamic = "force-dynamic";

const enc = new TextEncoder();

function sseComment(): Uint8Array {
  return enc.encode(": ping\n\n");
}

function sseData(data: string): Uint8Array {
  return enc.encode(`data: ${data}\n\n`);
}

/**
 * GET /api/v1/notifications/stream
 *
 * SSE endpoint. Subscribes to `notif:{userId}` via a duplicated Redis
 * connection and forwards each message as a `data:` line.
 * Sends a keep-alive comment every 25 s to prevent proxy timeouts.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const channel = notifChannel(auth.sub);

    const main = await getRedis();
    const subscriber = main.duplicate();
    await subscriber.connect();

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    function cleanup() {
      if (closed) return;
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect().catch(() => {});
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        controller = ctrl;

        await subscriber.subscribe(channel, (message) => {
          if (closed) return;
          try {
            ctrl.enqueue(sseData(message));
          } catch {
            cleanup();
          }
        });

        // Keep-alive ping every 25 s
        pingTimer = setInterval(() => {
          if (closed) return;
          try {
            ctrl.enqueue(sseComment());
          } catch {
            cleanup();
          }
        }, 25_000);
      },
      cancel() {
        cleanup();
      },
    });

    // Detect client disconnect via the request signal
    req.signal.addEventListener("abort", () => {
      cleanup();
      try {
        controller?.close();
      } catch {
        // already closed
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
