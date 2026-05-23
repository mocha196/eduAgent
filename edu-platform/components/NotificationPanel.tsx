"use client";

import { useRouter } from "next/navigation";
import {
  Bell,
  BookOpen,
  CheckSquare,
  FileCheck,
  FileX,
  Megaphone,
  Send,
  Star,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { NotificationDto } from "@/hooks/useNotifications";

// ── Relative time (no external dep) ──────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "刚刚";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

// ── Type → icon mapping ───────────────────────────────────────────────────
const TYPE_ICON: Record<string, React.ReactNode> = {
  MATERIAL_UPLOADED: <BookOpen className="size-4 text-blue-500" />,
  MATERIAL_READY: <FileCheck className="size-4 text-green-500" />,
  ASSIGNMENT_GENERATED: <CheckSquare className="size-4 text-indigo-500" />,
  ASSIGNMENT_FAILED: <FileX className="size-4 text-red-500" />,
  ASSIGNMENT_PUBLISHED: <Megaphone className="size-4 text-orange-500" />,
  SUBMISSION_RECEIVED: <Send className="size-4 text-purple-500" />,
  GRADE_RETURNED: <Star className="size-4 text-yellow-500" />,
};

// ── Build navigation target from notification metadata ───────────────────
function resolveTarget(notif: NotificationDto): string | null {
  const m = notif.metadata ?? {};
  const courseId = m.courseId;
  const assignmentId = m.assignmentId;
  if (!courseId) return null;

  switch (notif.type) {
    case "MATERIAL_UPLOADED":
    case "MATERIAL_READY":
      return `/courses/${courseId}`;
    case "ASSIGNMENT_GENERATED":
    case "ASSIGNMENT_FAILED":
    case "ASSIGNMENT_PUBLISHED":
      return assignmentId
        ? `/courses/${courseId}/assignments/${assignmentId}`
        : `/courses/${courseId}`;
    case "SUBMISSION_RECEIVED":
      return assignmentId
        ? `/courses/${courseId}/assignments/${assignmentId}/submissions`
        : `/courses/${courseId}`;
    case "GRADE_RETURNED":
      return assignmentId
        ? `/courses/${courseId}/assignments/${assignmentId}/submissions/mine`
        : `/courses/${courseId}`;
    default:
      return `/courses/${courseId}`;
  }
}

// ── Single row ────────────────────────────────────────────────────────────
function NotificationItem({
  notif,
  onRead,
  onClose,
}: {
  notif: NotificationDto;
  onRead: (id: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const icon = TYPE_ICON[notif.type] ?? <Bell className="size-4" />;
  const target = resolveTarget(notif);

  function handleClick() {
    if (!notif.isRead) onRead(notif.id);
    if (target) {
      router.push(target);
      onClose();
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent",
        !notif.isRead && "bg-accent/50",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{notif.title}</p>
          {!notif.isRead && (
            <span className="size-2 shrink-0 rounded-full bg-blue-500" />
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{notif.body}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {relativeTime(notif.createdAt)}
        </p>
      </div>
    </button>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────
export interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  notifications: NotificationDto[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
}

export function NotificationPanel({
  open,
  onClose,
  notifications,
  onMarkRead,
  onMarkAllRead,
}: NotificationPanelProps) {
  const hasUnread = notifications.some((n) => !n.isRead);

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="flex w-80 flex-col p-0 sm:max-w-sm">
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <SheetTitle className="text-base">通知</SheetTitle>
          {hasUnread && (
            <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" onClick={onMarkAllRead}>
              全部已读
            </Button>
          )}
        </SheetHeader>

        <ScrollArea className="flex-1">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Bell className="size-8 opacity-30" />
              <p className="text-sm">暂无通知</p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-2">
              {notifications.map((n) => (
                <NotificationItem
                  key={n.id}
                  notif={n}
                  onRead={onMarkRead}
                  onClose={onClose}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
