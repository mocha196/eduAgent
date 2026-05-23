/**
 * TC-NOTIF-001…006: Unit tests for notificationService.
 * No real DB / Redis required — all external deps are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationType } from "@prisma/client";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const {
  notifCreateMock,
  notifCreateManyMock,
  notifFindManyMock,
  notifCountMock,
  notifUpdateManyMock,
} = vi.hoisted(() => ({
  notifCreateMock: vi.fn(),
  notifCreateManyMock: vi.fn(),
  notifFindManyMock: vi.fn(),
  notifCountMock: vi.fn(),
  notifUpdateManyMock: vi.fn(),
}));

const { publishNotificationMock } = vi.hoisted(() => ({
  publishNotificationMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    notification: {
      create: notifCreateMock,
      createMany: notifCreateManyMock,
      findMany: notifFindManyMock,
      count: notifCountMock,
      updateMany: notifUpdateManyMock,
    },
  },
}));

vi.mock("@/lib/redis-pubsub", () => ({
  publishNotification: publishNotificationMock,
  notifChannel: (userId: string) => `notif:${userId}`,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
const USER_ID = "user-uuid-0001";
const NOTIF_ID = "notif-uuid-0001";

function makeDbRow(overrides: Partial<{
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: unknown;
  isRead: boolean;
  createdAt: Date;
}> = {}) {
  return {
    id: NOTIF_ID,
    userId: USER_ID,
    type: NotificationType.MATERIAL_UPLOADED,
    title: "课件上传成功",
    body: "《slides.pdf》已上传，正在处理中。",
    metadata: { courseId: "c1" },
    isRead: false,
    createdAt: new Date("2026-05-23T10:00:00Z"),
    ...overrides,
  };
}

// ── createNotification ────────────────────────────────────────────────────────
describe("createNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("TC-NOTIF-001: persists to DB and returns DTO", async () => {
    notifCreateMock.mockResolvedValue(makeDbRow());
    publishNotificationMock.mockResolvedValue(undefined);

    const { createNotification } = await import("@/lib/services/notificationService");
    const result = await createNotification({
      userId: USER_ID,
      type: NotificationType.MATERIAL_UPLOADED,
      title: "课件上传成功",
      body: "《slides.pdf》已上传，正在处理中。",
      metadata: { courseId: "c1" },
    });

    expect(notifCreateMock).toHaveBeenCalledOnce();
    expect(notifCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          type: NotificationType.MATERIAL_UPLOADED,
        }),
      }),
    );
    expect(result.id).toBe(NOTIF_ID);
    expect(result.isRead).toBe(false);
    expect(result.createdAt).toBe("2026-05-23T10:00:00.000Z");
  });

  it("TC-NOTIF-002: publishes to Redis after DB write (best-effort, non-blocking)", async () => {
    notifCreateMock.mockResolvedValue(makeDbRow());
    publishNotificationMock.mockResolvedValue(undefined);

    const { createNotification } = await import("@/lib/services/notificationService");
    await createNotification({
      userId: USER_ID,
      type: NotificationType.MATERIAL_UPLOADED,
      title: "课件上传成功",
      body: "body",
    });

    // publishNotification is called with void, give it a tick to fire
    await new Promise((r) => setImmediate(r));
    expect(publishNotificationMock).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ id: NOTIF_ID }));
  });

  it("TC-NOTIF-002: Redis publish failure does NOT reject createNotification", async () => {
    notifCreateMock.mockResolvedValue(makeDbRow());
    publishNotificationMock.mockRejectedValue(new Error("Redis down"));

    const { createNotification } = await import("@/lib/services/notificationService");
    // Should resolve (not throw) even if Redis fails
    await expect(
      createNotification({
        userId: USER_ID,
        type: NotificationType.MATERIAL_UPLOADED,
        title: "课件上传成功",
        body: "body",
      }),
    ).resolves.toBeDefined();
  });
});

// ── createBulkNotifications ───────────────────────────────────────────────────
describe("createBulkNotifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("TC-NOTIF-003: no-op when userIds is empty", async () => {
    const { createBulkNotifications } = await import("@/lib/services/notificationService");
    await createBulkNotifications({
      userIds: [],
      type: NotificationType.ASSIGNMENT_PUBLISHED,
      title: "作业已发布",
      body: "body",
    });

    expect(notifCreateManyMock).not.toHaveBeenCalled();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("TC-NOTIF-003: creates records for each userId and publishes each", async () => {
    const userIds = ["u1", "u2", "u3"];
    notifCreateManyMock.mockResolvedValue({ count: 3 });
    notifFindManyMock.mockResolvedValue(
      userIds.map((userId) => makeDbRow({ userId, id: `notif-${userId}` })),
    );
    publishNotificationMock.mockResolvedValue(undefined);

    const { createBulkNotifications } = await import("@/lib/services/notificationService");
    await createBulkNotifications({
      userIds,
      type: NotificationType.ASSIGNMENT_PUBLISHED,
      title: "作业已发布",
      body: "请完成作业。",
    });

    expect(notifCreateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ userId: "u1" }),
          expect.objectContaining({ userId: "u2" }),
          expect.objectContaining({ userId: "u3" }),
        ]),
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(publishNotificationMock).toHaveBeenCalledTimes(3);
  });
});

// ── listNotifications ─────────────────────────────────────────────────────────
describe("listNotifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("TC-NOTIF-004: returns last 50 notifications and unread count", async () => {
    const rows = [makeDbRow(), makeDbRow({ id: "notif-2", isRead: true })];
    notifFindManyMock.mockResolvedValue(rows);
    notifCountMock.mockResolvedValue(1);

    const { listNotifications } = await import("@/lib/services/notificationService");
    const result = await listNotifications(USER_ID);

    expect(result.notifications).toHaveLength(2);
    expect(result.unreadCount).toBe(1);
    expect(notifFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, take: 50 }),
    );
  });

  it("TC-NOTIF-004: empty result when user has no notifications", async () => {
    notifFindManyMock.mockResolvedValue([]);
    notifCountMock.mockResolvedValue(0);

    const { listNotifications } = await import("@/lib/services/notificationService");
    const result = await listNotifications(USER_ID);

    expect(result.notifications).toHaveLength(0);
    expect(result.unreadCount).toBe(0);
  });
});

// ── markAsRead ────────────────────────────────────────────────────────────────
describe("markAsRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("TC-NOTIF-005: calls updateMany scoped to userId and notificationId", async () => {
    notifUpdateManyMock.mockResolvedValue({ count: 1 });

    const { markAsRead } = await import("@/lib/services/notificationService");
    await markAsRead(USER_ID, NOTIF_ID);

    expect(notifUpdateManyMock).toHaveBeenCalledWith({
      where: { id: NOTIF_ID, userId: USER_ID },
      data: { isRead: true },
    });
  });

  it("TC-NOTIF-005: does NOT throw when notification not found (count=0)", async () => {
    notifUpdateManyMock.mockResolvedValue({ count: 0 });

    const { markAsRead } = await import("@/lib/services/notificationService");
    await expect(markAsRead(USER_ID, "nonexistent-id")).resolves.toBeUndefined();
  });
});

// ── markAllRead ───────────────────────────────────────────────────────────────
describe("markAllRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("TC-NOTIF-006: marks all unread notifications for userId", async () => {
    notifUpdateManyMock.mockResolvedValue({ count: 5 });

    const { markAllRead } = await import("@/lib/services/notificationService");
    await markAllRead(USER_ID);

    expect(notifUpdateManyMock).toHaveBeenCalledWith({
      where: { userId: USER_ID, isRead: false },
      data: { isRead: true },
    });
  });
});
