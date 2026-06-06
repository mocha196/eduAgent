"use client";

import { useEffect, useState } from "react";
import { Brain, Trash2, AlertCircle, CheckCircle2, BookMarked, Lightbulb, RefreshCw, Bell, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  MemoryReviewCardModal,
  type MemoryReviewSession,
} from "@/components/MemoryReviewCardModal";

// ── Types ────────────────────────────────────────────────────────────────────

type MemoryFact = {
  id: string;
  category: string;
  content: string;
  confidence: number;
  timestamp: string;
  sessionId: string;
};

type MemoryConcept = {
  id: string;
  name: string;
  description: string;
  masteryLevel: number;
  lastUpdated: string;
};

type ReviewPreference = {
  enabled: boolean;
  localTime: string;
  timezone: string;
};

// ── Category labels ──────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  concept_mastery: "概念掌握",
  concept_confusion: "概念困惑",
  preference: "学习偏好",
  difficulty: "难点",
  question: "问题",
  achievement: "成就",
};

const CATEGORY_COLORS: Record<string, string> = {
  concept_mastery: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  concept_confusion: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  preference: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  difficulty: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  question: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  achievement: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
};

// ── Notification helper ───────────────────────────────────────────────────────

function useNotify() {
  const [n, setN] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const notify = (type: "success" | "error", msg: string) => {
    setN({ type, msg });
    setTimeout(() => setN(null), 4000);
  };
  return { notification: n, notify };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function MemoriesPage() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [concepts, setConcepts] = useState<MemoryConcept[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { notification, notify } = useNotify();

  // ── On-demand review modal ────────────────────────────────────────────────
  const [reviewSession, setReviewSession] = useState<MemoryReviewSession | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewStarting, setReviewStarting] = useState(false);

  async function startReview() {
    setReviewStarting(true);
    try {
      const res = await fetch("/api/v1/me/memory-reviews/start", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) { notify("error", "启动复习失败"); return; }
      const data = (await res.json()) as
        | { status: "active"; session: MemoryReviewSession }
        | { status: "completed" }
        | { status: "no_concepts" };
      if (data.status === "completed") { notify("success", "今日复习已完成，明天再来！"); return; }
      if (data.status === "no_concepts") { notify("error", "暂无可复习的知识点，先多和 AI 聊聊吧"); return; }
      setReviewSession(data.session);
      setReviewOpen(true);
    } catch {
      notify("error", "启动复习失败");
    } finally {
      setReviewStarting(false);
    }
  }

  // ── Review preference ─────────────────────────────────────────────────────
  const [pref, setPref] = useState<ReviewPreference | null>(null);
  const [prefBusy, setPrefBusy] = useState(false);
  const [editLocalTime, setEditLocalTime] = useState("09:00");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/v1/me/memory-reviews/preferences", {
          credentials: "same-origin",
        });
        if (res.ok) {
          const data = (await res.json()) as ReviewPreference;
          setPref(data);
          setEditLocalTime(data.localTime);
        }
      } catch {
        // non-critical
      }
    })();
  }, []);

  async function savePref(updates: Partial<ReviewPreference>) {
    if (!pref) return;
    setPrefBusy(true);
    try {
      const merged = { ...pref, ...updates };
      const res = await fetch("/api/v1/me/memory-reviews/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(merged),
      });
      if (res.ok) {
        const data = (await res.json()) as ReviewPreference;
        setPref(data);
        setEditLocalTime(data.localTime);
        notify("success", "复习偏好已保存");
      } else {
        notify("error", "保存失败，请检查格式");
      }
    } finally {
      setPrefBusy(false);
    }
  }

  async function loadMemories() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/me/memories", { credentials: "include" });
      if (!res.ok) { notify("error", "加载记忆失败"); return; }
      const data = (await res.json()) as { facts: MemoryFact[]; concepts: MemoryConcept[] };
      setFacts(data.facts ?? []);
      setConcepts(data.concepts ?? []);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMemories(); }, []);

  async function deleteFact(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/me/memories/facts/${id}`, {
        method: "DELETE", credentials: "include",
      });
      if (res.ok) {
        setFacts((prev) => prev.filter((f) => f.id !== id));
        notify("success", "已删除该记忆");
      } else {
        notify("error", "删除失败");
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteConcept(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/me/memories/concepts/${id}`, {
        method: "DELETE", credentials: "include",
      });
      if (res.ok) {
        setConcepts((prev) => prev.filter((c) => c.id !== id));
        notify("success", "已删除该概念");
      } else {
        notify("error", "删除失败");
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("确定清空全部长期记忆？此操作不可撤销。")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/me/memories", {
        method: "DELETE", credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { deleted_facts: number; deleted_concepts: number };
        setFacts([]);
        setConcepts([]);
        notify("success", `已清空 ${data.deleted_facts} 条事实、${data.deleted_concepts} 个概念`);
      } else {
        notify("error", "清空失败");
      }
    } finally {
      setBusy(false);
    }
  }

  const isEmpty = facts.length === 0 && concepts.length === 0;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Notification */}
      {notification && (
        <div className={cn(
          "fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg",
          notification.type === "success"
            ? "bg-[oklch(0.92_0.08_145)] text-[oklch(0.35_0.10_145)]"
            : "bg-destructive text-destructive-foreground",
        )}>
          {notification.type === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {notification.msg}
        </div>
      )}

      <div className="max-w-2xl mx-auto w-full px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Brain size={20} className="text-primary" />长期记忆
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              AI 在对话中记录的关于你的学习偏好与掌握情况
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void loadMemories()}
            disabled={loading || busy}
            title="刷新"
          >
            <RefreshCw size={15} className={cn(loading && "animate-spin")} />
          </Button>
        </div>

        {/* Daily Review Preference */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Bell size={15} className="text-primary" />
            <h2 className="text-sm font-semibold text-foreground">每日记忆复习</h2>
          </div>
          {!pref ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : (
            <div className="space-y-4">
              {/* Local time */}
              <div className="space-y-1.5">
                <Label htmlFor="review-time" className="text-xs text-muted-foreground">
                  希望收到通知的时间
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="review-time"
                    type="time"
                    value={editLocalTime}
                    onChange={(e) => setEditLocalTime(e.target.value)}
                    className="h-8 text-sm w-32"
                    disabled={prefBusy}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 shrink-0"
                    disabled={prefBusy || editLocalTime === pref.localTime}
                    onClick={() => void savePref({ localTime: editLocalTime })}
                  >
                    保存
                  </Button>
                </div>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <input
                    id="review-enabled"
                    type="checkbox"
                    className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                    checked={pref.enabled}
                    disabled={prefBusy}
                    onChange={(e) => void savePref({ enabled: e.target.checked })}
                  />
                  <Label htmlFor="review-enabled" className="text-sm cursor-pointer">
                    开启每日自动复习提醒
                  </Label>
                </div>
                {pref.enabled && (
                  <span className="text-xs text-muted-foreground">
                    将于 {editLocalTime} 生成今日题目
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                系统将在指定时间为你生成复习题，每日 5 道题巩固薄弱知识点。
              </p>

              {/* Manual start */}
              <Button
                size="sm"
                className="w-full"
                onClick={() => void startReview()}
                disabled={reviewStarting}
              >
                <Play size={13} className="mr-1.5" />
                {reviewStarting ? "生成中…" : "立即开始复习"}
              </Button>
            </div>
          )}
        </section>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
            <Brain size={32} className="mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">暂无长期记忆</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              继续与 AI 对话，它会自动记录你的学习偏好和掌握情况
            </p>
          </div>
        ) : (
          <>
            {/* Concepts */}
            {concepts.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  <Lightbulb size={14} className="text-amber-500" />
                  概念掌握 <span className="text-muted-foreground font-normal">({concepts.length})</span>
                </h2>
                <div className="space-y-2">
                  {concepts.map((c) => (
                    <div
                      key={c.id}
                      className="group flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            掌握度 {(c.masteryLevel * 100).toFixed(0)}%
                          </span>
                        </div>
                        {/* Mastery progress bar */}
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              c.masteryLevel >= 0.7
                                ? "bg-emerald-500"
                                : c.masteryLevel >= 0.4
                                ? "bg-amber-500"
                                : "bg-rose-500",
                            )}
                            style={{ width: `${Math.min(c.masteryLevel * 100, 100)}%` }}
                          />
                        </div>
                        {c.description && (
                          <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">{c.description}</p>
                        )}
                        <p className="mt-1 text-[10px] text-muted-foreground/60">
                          {new Date(c.lastUpdated).toLocaleDateString("zh-CN")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                        disabled={busy}
                        onClick={() => void deleteConcept(c.id)}
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Facts */}
            {facts.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  <BookMarked size={14} className="text-primary" />
                  学习事实 <span className="text-muted-foreground font-normal">({facts.length})</span>
                </h2>
                <div className="space-y-2">
                  {facts.map((f) => (
                    <div
                      key={f.id}
                      className="group flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                            CATEGORY_COLORS[f.category] ?? "bg-muted text-muted-foreground",
                          )}>
                            {CATEGORY_LABELS[f.category] ?? f.category}
                          </span>
                          <span className="text-[10px] text-muted-foreground/60">
                            置信度 {(f.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-1.5 text-sm text-foreground leading-relaxed">{f.content}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground/60">
                          {new Date(f.timestamp).toLocaleDateString("zh-CN")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                        disabled={busy}
                        onClick={() => void deleteFact(f.id)}
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Danger zone */}
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-5 space-y-3">
              <p className="text-sm font-semibold text-foreground">清空全部</p>
              <p className="text-xs text-muted-foreground">
                删除所有已记录的事实和概念，AI 将从零开始了解你的学习情况。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void clearAll()}
                disabled={busy}
                className="text-destructive border-destructive/30 hover:bg-destructive/8 hover:text-destructive"
              >
                <Trash2 size={13} className="mr-1.5" />
                清空全部记忆
              </Button>
            </div>
          </>
        )}
      </div>

      {/* On-demand review modal */}
      {reviewSession && (
        <MemoryReviewCardModal
          session={reviewSession}
          open={reviewOpen}
          onClose={() => {
            setReviewOpen(false);
            setReviewSession(null);
          }}
        />
      )}
    </div>
  );
}
