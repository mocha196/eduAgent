"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, string> | null;
  isRead: boolean;
  createdAt: string;
}

interface UseNotificationsReturn {
  notifications: NotificationDto[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export function useNotifications(): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/v1/notifications", { credentials: "same-origin" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          notifications: NotificationDto[];
          unreadCount: number;
        };
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      } catch {
        // Silent — page still usable without notifications
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // ── SSE stream ────────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/v1/notifications/stream");
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const notif = JSON.parse(evt.data as string) as NotificationDto;
        setNotifications((prev) => [notif, ...prev].slice(0, 50));
        if (!notif.isRead) setUnreadCount((n) => n + 1);
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  // ── Mark single read ──────────────────────────────────────────────────────
  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));

    fetch(`/api/v1/notifications/${id}/read`, {
      method: "PATCH",
      credentials: "same-origin",
    }).catch(() => {});
  }, []);

  // ── Mark all read ─────────────────────────────────────────────────────────
  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);

    fetch("/api/v1/notifications", {
      method: "PATCH",
      credentials: "same-origin",
    }).catch(() => {});
  }, []);

  return { notifications, unreadCount, markRead, markAllRead };
}
