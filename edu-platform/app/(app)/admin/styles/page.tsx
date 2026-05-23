"use client";

import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Lock,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

type AgentStyle = {
  id: string;
  name: string;
  description: string;
  body: string;
  alwaysInject: boolean;
  enabled: boolean;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  name: string;
  description: string;
  body: string;
  alwaysInject: boolean;
  enabled: boolean;
};

function useNotify() {
  const [n, setN] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = (type: "success" | "error", msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setN({ type, msg });
    timerRef.current = setTimeout(() => setN(null), 4000);
  };
  return { notification: n, notify };
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  body: "",
  alwaysInject: false,
  enabled: true,
};

export default function AdminStylesPage() {
  const [styles, setStyles] = useState<AgentStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentStyle | null>(null); // null = create
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { notification, notify } = useNotify();

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/styles", { credentials: "include" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { notify("error", "加载失败"); return; }
      const data = (await res.json()) as { styles: AgentStyle[] };
      setStyles(data.styles);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  function openCreate() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(style: AgentStyle) {
    setEditTarget(style);
    setForm({
      name: style.name,
      description: style.description,
      body: style.body,
      alwaysInject: style.alwaysInject,
      enabled: style.enabled,
    });
    setDialogOpen(true);
  }

  async function handleSubmit() {
    const trimmed = { ...form, name: form.name.trim(), description: form.description.trim(), body: form.body.trim() };
    if (!trimmed.name) { notify("error", "名称不能为空"); return; }
    if (!trimmed.body) { notify("error", "角色定义不能为空"); return; }

    setSubmitting(true);
    try {
      let res: Response;
      if (editTarget) {
        res = await fetch(`/api/v1/admin/styles/${editTarget.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trimmed),
        });
      } else {
        res = await fetch("/api/v1/admin/styles", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trimmed),
        });
      }

      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        notify("error", err.message ?? "操作失败");
        return;
      }

      const data = (await res.json()) as { style: AgentStyle };
      if (editTarget) {
        setStyles((prev) => prev.map((s) => (s.id === editTarget.id ? data.style : s)));
        notify("success", `风格 "${data.style.name}" 已更新`);
      } else {
        setStyles((prev) => [...prev, data.style]);
        notify("success", `风格 "${data.style.name}" 已创建`);
      }
      setDialogOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(style: AgentStyle) {
    const res = await fetch(`/api/v1/admin/styles/${style.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !style.enabled }),
    });
    if (!res.ok) { notify("error", "切换失败"); return; }
    const data = (await res.json()) as { style: AgentStyle };
    setStyles((prev) => prev.map((s) => (s.id === style.id ? data.style : s)));
  }

  async function handleDelete(style: AgentStyle) {
    if (!window.confirm(`确定删除风格 "${style.name}"？此操作不可撤销。`)) return;
    const res = await fetch(`/api/v1/admin/styles/${style.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      const err = (await res.json()) as { message?: string };
      notify("error", err.message ?? "删除失败");
      return;
    }
    setStyles((prev) => prev.filter((s) => s.id !== style.id));
    notify("success", `风格 "${style.name}" 已删除`);
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
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Sparkles size={20} className="text-primary" />
              风格管理
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              管理 Agent 的说话风格。启用的风格将注入到 AI 对话的系统提示词中。
            </p>
          </div>
          <Button size="sm" onClick={openCreate} className="shrink-0 gap-1.5">
            <Plus size={14} />
            新建风格
          </Button>
        </div>

        {/* Style list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((k) => (
              <Skeleton key={k} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {styles.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                暂无风格，点击右上角按钮新建
              </p>
            )}
            {styles.map((style) => (
              <div
                key={style.id}
                className={cn(
                  "flex items-start gap-4 rounded-xl border bg-card p-4 transition-opacity",
                  !style.enabled && "opacity-50",
                )}
              >
                {/* Left icon */}
                <div className="mt-0.5 shrink-0 h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Sparkles size={14} className="text-primary" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">
                      {style.name}
                    </span>
                    {style.isBuiltIn && (
                      <Badge variant="secondary" className="text-[10px] gap-0.5 px-1.5 py-0">
                        <Lock size={9} />
                        内置
                      </Badge>
                    )}
                    {style.alwaysInject && (
                      <Badge className="text-[10px] gap-0.5 px-1.5 py-0 bg-blue-500/10 text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800">
                        <Zap size={9} />
                        总是注入
                      </Badge>
                    )}
                  </div>
                  {style.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {style.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground/60 font-mono line-clamp-1">
                    {style.body.slice(0, 80)}{style.body.length > 80 ? "…" : ""}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0 mt-0.5">
                  {/* Enabled toggle */}
                  <button
                    onClick={() => void toggleEnabled(style)}
                    title={style.enabled ? "点击禁用" : "点击启用"}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      style.enabled ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
                        style.enabled ? "translate-x-4" : "translate-x-0.5",
                      )}
                    />
                  </button>
                  {/* Edit button */}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="编辑"
                    onClick={() => openEdit(style)}
                  >
                    <Pencil size={13} />
                  </Button>
                  {/* Delete button */}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title={style.isBuiltIn ? "内置风格不可删除" : "删除"}
                    disabled={style.isBuiltIn}
                    onClick={() => void handleDelete(style)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editTarget ? `编辑风格：${editTarget.name}` : "新建风格"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="style-name">
                名称
                <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="style-name"
                placeholder="例如：EDUCATOR、socratic"
                value={form.name}
                disabled={editTarget?.isBuiltIn ?? false}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              {editTarget?.isBuiltIn && (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Lock size={10} />
                  内置风格名称不可修改
                </p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="style-desc">描述</Label>
              <Input
                id="style-desc"
                placeholder="简短描述此风格的用途（最多 200 字）"
                maxLength={200}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor="style-body">
                角色定义
                <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Textarea
                id="style-body"
                placeholder={"在此填写注入到系统提示词的 Markdown 内容。\n例如：\n# Role\nYou are an encouraging educator..."}
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                className="font-mono text-xs min-h-[180px] resize-y"
              />
            </div>

            {/* alwaysInject toggle */}
            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
              <button
                onClick={() => setForm((f) => ({ ...f, alwaysInject: !f.alwaysInject }))}
                className={cn(
                  "relative inline-flex mt-0.5 h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  form.alwaysInject ? "bg-blue-500" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
                    form.alwaysInject ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
              <div>
                <p className="text-sm font-medium leading-none">总是注入</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  开启后此风格将直接合并进所有对话的系统提示词；关闭则仅作为可选技能列在上下文中。
                </p>
              </div>
            </div>

            {/* enabled toggle */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  form.enabled ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
                    form.enabled ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
              <Label className="cursor-pointer select-none" onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}>
                启用此风格
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? "保存中…" : editTarget ? "保存更改" : "创建风格"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
