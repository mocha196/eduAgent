"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Blocks,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  GripVertical,
  FolderOpen,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SkillSource = {
  path: string;
  label: string;
  enabled: boolean;
};

function useNotify() {
  const [n, setN] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const notify = (type: "success" | "error", msg: string) => {
    setN({ type, msg });
    setTimeout(() => setN(null), 4000);
  };
  return { notification: n, notify };
}

export default function AdminSkillsPage() {
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const { notification, notify } = useNotify();

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/skills", { credentials: "include" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { notify("error", "加载失败"); return; }
      const data = (await res.json()) as { sources: SkillSource[] };
      setSources(data.sources);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  async function save(updated: SkillSource[]) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/skills", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: updated }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        notify("error", err.message ?? "保存失败");
        return;
      }
      const data = (await res.json()) as { sources: SkillSource[] };
      setSources(data.sources);
      notify("success", "已保存并重新加载技能配置");
    } finally {
      setSaving(false);
    }
  }

  function toggleEnabled(idx: number) {
    const updated = sources.map((s, i) =>
      i === idx ? { ...s, enabled: !s.enabled } : s,
    );
    void save(updated);
  }

  function remove(idx: number) {
    if (!window.confirm(`确定移除来源 "${sources[idx].label}"？`)) return;
    void save(sources.filter((_, i) => i !== idx));
  }

  function addSource() {
    const p = newPath.trim();
    const l = newLabel.trim();
    if (!p || !l) { notify("error", "路径和标签不能为空"); return; }
    if (l.length > 50) { notify("error", "标签最多 50 个字符"); return; }
    void save([...sources, { path: p, label: l, enabled: true }]);
    setNewPath("");
    setNewLabel("");
  }

  if (forbidden) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        仅管理员可访问此页面
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {notification && (
        <div
          className={cn(
            "fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg",
            notification.type === "success"
              ? "bg-[oklch(0.92_0.08_145)] text-[oklch(0.35_0.10_145)]"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {notification.type === "success" ? (
            <CheckCircle2 size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
          {notification.msg}
        </div>
      )}

      <div className="max-w-2xl mx-auto w-full px-6 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Blocks size={20} className="text-primary" />
            技能管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理 Agent 可用的 skill 来源目录。路径相对于{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">edu-platform/</code>
            {" "}（即 <code className="rounded bg-muted px-1 py-0.5 text-xs">process.cwd()</code>）。
          </p>
        </div>

        {/* Source list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((k) => (
              <Skeleton key={k} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {sources.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                暂无来源，请在下方添加
              </p>
            )}
            {sources.map((src, idx) => (
              <div
                key={idx}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card p-4 transition-opacity",
                  !src.enabled && "opacity-50",
                )}
              >
                <GripVertical
                  size={16}
                  className="mt-0.5 shrink-0 text-muted-foreground/40 cursor-grab"
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Tag size={12} className="text-muted-foreground shrink-0" />
                    <span className="text-sm font-semibold text-foreground truncate">
                      {src.label}
                    </span>
                    {idx === 0 && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        最高优先级
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <FolderOpen size={12} className="text-muted-foreground shrink-0" />
                    <code className="text-xs text-muted-foreground break-all">{src.path}</code>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Enable toggle */}
                  <button
                    onClick={() => toggleEnabled(idx)}
                    disabled={saving}
                    title={src.enabled ? "点击禁用" : "点击启用"}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      src.enabled ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
                        src.enabled ? "translate-x-4" : "translate-x-0.5",
                      )}
                    />
                  </button>
                  {/* Remove */}
                  <button
                    onClick={() => remove(idx)}
                    disabled={saving}
                    title="移除此来源"
                    className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add new source */}
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-5 space-y-4">
          <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Plus size={14} className="text-primary" />
            添加技能来源
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">路径（相对或绝对）</label>
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="../custom-skills"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">标签（显示名称）</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="custom"
                maxLength={50}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={addSource}
            disabled={saving || !newPath.trim() || !newLabel.trim()}
          >
            <Plus size={13} className="mr-1.5" />
            添加并保存
          </Button>
        </div>

        {/* Hint */}
        <p className="text-xs text-muted-foreground">
          来源优先级从上到下递减，先出现的来源中同名技能优先。修改后立即生效（无需重启）。
          使用{" "}
          <code className="rounded bg-muted px-1 py-0.5">npm run skill:install</code>
          {" "}可从 GitHub 快速下载技能包。
        </p>
      </div>
    </div>
  );
}
