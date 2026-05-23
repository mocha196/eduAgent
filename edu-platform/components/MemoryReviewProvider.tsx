"use client";

import { useEffect, useRef, useState } from "react";
import { useNotifications } from "@/hooks/useNotifications";
import {
  MemoryReviewCardModal,
  type MemoryReviewSession,
} from "@/components/MemoryReviewCardModal";

/**
 * MemoryReviewProvider
 *
 * Mount this once in the app layout. It:
 *  1. Listens for MEMORY_REVIEW_READY notifications (via the existing useNotifications SSE hook).
 *  2. On first load, also polls /api/v1/me/memory-reviews/pending for sessions created
 *     while the user was offline (e.g. yesterday's session still pending).
 *  3. Opens MemoryReviewCardModal when a pending session is detected.
 */
export function MemoryReviewProvider() {
  const { notifications } = useNotifications();
  const [session, setSession] = useState<MemoryReviewSession | null>(null);
  const [open, setOpen] = useState(false);
  const loadedRef = useRef(false);
  const shownSessionIds = useRef<Set<string>>(new Set());

  // ── Initial poll: pick up sessions created while user was offline ─────────
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    void (async () => {
      try {
        const res = await fetch("/api/v1/me/memory-reviews/pending", {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { session: MemoryReviewSession | null };
        if (data.session && !shownSessionIds.current.has(data.session.sessionId)) {
          shownSessionIds.current.add(data.session.sessionId);
          setSession(data.session);
          setOpen(true);
        }
      } catch {
        // Silent — non-critical
      }
    })();
  }, []);

  // ── SSE trigger: new MEMORY_REVIEW_READY notification ────────────────────
  useEffect(() => {
    const latest = notifications[0];
    if (!latest || latest.type !== "MEMORY_REVIEW_READY") return;

    const sessionId = latest.metadata?.sessionId as string | undefined;
    if (!sessionId || shownSessionIds.current.has(sessionId)) return;

    // Fetch the full session payload
    void (async () => {
      try {
        const res = await fetch("/api/v1/me/memory-reviews/pending", {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { session: MemoryReviewSession | null };
        if (data.session && !shownSessionIds.current.has(data.session.sessionId)) {
          shownSessionIds.current.add(data.session.sessionId);
          setSession(data.session);
          setOpen(true);
        }
      } catch {
        // Silent
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications[0]?.id]); // only re-run when a new notification arrives

  if (!session) return null;

  return (
    <MemoryReviewCardModal
      session={session}
      open={open}
      onClose={() => {
        setOpen(false);
        setSession(null);
      }}
    />
  );
}
