import { type NotificationType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { publishNotification, type NotificationPayload } from "@/lib/redis-pubsub";

export type { NotificationPayload };

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

function toDto(row: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: unknown;
  isRead: boolean;
  createdAt: Date;
}): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Create a single notification and publish it via Redis Pub/Sub. */
export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  dedupKey?: string;
}): Promise<NotificationDto> {
  const data = {
    userId: params.userId,
    type: params.type,
    title: params.title,
    body: params.body,
    metadata: (params.metadata ?? undefined) as object | undefined,
    dedupKey: params.dedupKey,
  };
  let row;
  let created = true;
  try {
    row = await prisma.notification.create({ data });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (!params.dedupKey || code !== "P2002") throw error;
    created = false;
    row = await prisma.notification.findFirst({
      where: { userId: params.userId, dedupKey: params.dedupKey },
    });
    if (!row) throw error;
  }
  const dto = toDto(row);
  // Best-effort real-time push; failures are logged inside publishNotification.
  if (created) void publishNotification(params.userId, dto as NotificationPayload);
  return dto;
}

/** Create notifications for multiple users (broadcast). */
export async function createBulkNotifications(params: {
  userIds: string[];
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  dedupKey?: string;
}): Promise<void> {
  if (params.userIds.length === 0) return;
  if (params.dedupKey) {
    await Promise.all(
      params.userIds.map((userId) =>
        createNotification({
          userId,
          type: params.type,
          title: params.title,
          body: params.body,
          metadata: params.metadata,
          dedupKey: params.dedupKey,
        }),
      ),
    );
    return;
  }
  // createMany is faster but doesn't return rows; publish separately.
  await prisma.notification.createMany({
    data: params.userIds.map((userId) => ({
      userId,
      type: params.type,
      title: params.title,
      body: params.body,
      metadata: (params.metadata ?? undefined) as object | undefined,
    })),
    skipDuplicates: true,
  });
  // Fetch the just-created rows to get their IDs for publishing.
  const rows = await prisma.notification.findMany({
    where: {
      userId: { in: params.userIds },
      type: params.type,
      isRead: false,
    },
    orderBy: { createdAt: "desc" },
    take: params.userIds.length,
  });
  for (const row of rows) {
    void publishNotification(row.userId, toDto(row) as NotificationPayload);
  }
}

/** List the most recent 50 notifications for a user, plus unread count. */
export async function listNotifications(userId: string): Promise<{
  notifications: NotificationDto[];
  unreadCount: number;
}> {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { notifications: notifications.map(toDto), unreadCount };
}

/** Mark a single notification as read (must belong to userId). */
export async function markAsRead(
  userId: string,
  notificationId: string,
): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
}

/** Mark all notifications for a user as read. */
export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
}
