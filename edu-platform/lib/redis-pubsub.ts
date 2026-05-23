/**
 * Redis Pub/Sub helpers for real-time notification delivery.
 *
 * Publisher: uses the shared `getRedis()` connection (commands-mode).
 * Subscriber: callers must duplicate the client themselves because a
 *   subscribed connection can only issue pub/sub commands.
 */
import { getRedis } from "@/lib/redis";
import type { NotificationType } from "@prisma/client";

export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string; // ISO 8601
}

/** Redis channel for a specific user's notifications. */
export function notifChannel(userId: string): string {
  return `notif:${userId}`;
}

/** Publish a notification payload to a user's channel. */
export async function publishNotification(
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.publish(notifChannel(userId), JSON.stringify(payload));
  } catch {
    // Pub/Sub publish is best-effort; the DB record is the source of truth.
  }
}
