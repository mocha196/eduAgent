"use client";

import { useEffect, useState, useCallback } from "react";
import { Eye, EyeOff, Settings2, RotateCcw, Save, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// ---- Types -----------------------------------------------------------------

type LLMRoleKey = "chat" | "vision" | "title" | "memory" | "grading";

type RoleConfig = { apiKey: string; baseURL: string; model: string };
type LLMConfig = Record<LLMRoleKey, RoleConfig>;

const ROLES: { key: LLMRoleKey; label: string; desc: string }[] = [
  { key: "chat",    label: "对话助手",   desc: "主会话模型，驱动课程问答与 QA 中心 ReAct 循环" },
  { key: "vision",  label: "图像理解",   desc: "多模态模型，用于解析用户上传的图片附件" },
  { key: "title",   label: "标题生成",   desc: "轻量快速模型，用于生成会话标题与查询分解" },
  { key: "memory",  label: "记忆提取",   desc: "辅助模型，会话结束后异步提取长期学习记忆" },
  { key: "grading", label: "作业批改",   desc: "辅助模型，用于主观题 AI 评分与反馈续写" },
];

const EMPTY_ROLE: RoleConfig = { apiKey: "", baseURL: "", model: "" };

function emptyConfig(): LLMConfig {
  return {
    chat:    { ...EMPTY_ROLE },
    vision:  { ...EMPTY_ROLE },
    title:   { ...EMPTY_ROLE },
    memory:  { ...EMPTY_ROLE },
    grading: { ...EMPTY_ROLE },
  };
}

// ---- Notification ----------------------------------------------------------

type NotifState = { type: "success" | "error"; msg: string } | null;

function useNotify() {
  const [n, setN] = useState<NotifState>(null);
  const notify = useCallback((type: "success" | "error", msg: string) => {
    setN({ type, msg });
    setTimeout(() => setN(null), 4000);
  }, []);
  return { notification: n, notify };
}

// ---- Password-style field with reveal toggle -------------------------------

function ApiKeyField({
  value,
  placeholder,
  onChange,
  disabled,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "留空则继承系统配置"}
        disabled={disabled}
        className="pr-9 font-mono text-sm"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => setShow((s) => !s)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={show ? "隐藏 API Key" : "显示 API Key"}
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

// ---- Role panel ------------------------------------------------------------

function RolePanel({
  roleKey,
  config,
  onChange,
  disabled,
}: {
  roleKey: LLMRoleKey;
  config: RoleConfig;
  onChange: (key: keyof RoleConfig, value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${roleKey}-key`} className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          API Key
        </Label>
        <ApiKeyField
          value={config.apiKey}
          placeholder="留空则继承系统配置"
          onChange={(v) => onChange("apiKey", v)}
          disabled={disabled}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${roleKey}-url`} className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Base URL
        </Label>
        <Input
          id={`${roleKey}-url`}
          value={config.baseURL}
          onChange={(e) => onChange("baseURL", e.target.value)}
          placeholder="留空则继承系统配置（如 https://api.deepseek.com/v1）"
          disabled={disabled}
          className="font-mono text-sm"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${roleKey}-model`} className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Model
        </Label>
        <Input
          id={`${roleKey}-model`}
          value={config.model}
          onChange={(e) => onChange("model", e.target.value)}
          placeholder="留空则继承系统配置（如 deepseek-v3-250324）"
          disabled={disabled}
          className="font-mono text-sm"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// ---- Main page -------------------------------------------------------------

export default function LlmConfigPage() {
  const [config, setConfig] = useState<LLMConfig>(emptyConfig());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { notification, notify } = useNotify();

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/me/llm-config", { credentials: "include" });
      if (!res.ok) { notify("error", "加载配置失败"); return; }
      const data = (await res.json()) as { config: LLMConfig };
      setConfig(data.config);
    } catch {
      notify("error", "网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function setRoleField(role: LLMRoleKey, key: keyof RoleConfig, value: string) {
    setConfig((prev) => ({
      ...prev,
      [role]: { ...prev[role], [key]: value },
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/me/llm-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        notify("error", err.message ?? "保存失败");
        return;
      }
      const data = (await res.json()) as { config: LLMConfig };
      setConfig(data.config);
      notify("success", "配置已保存");
    } catch {
      notify("error", "网络错误，请重试");
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("确定要清除所有 LLM 覆盖配置，全部回退到系统默认设置？")) return;
    setClearing(true);
    try {
      const res = await fetch("/api/v1/me/llm-config", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) { notify("error", "重置失败"); return; }
      setConfig(emptyConfig());
      notify("success", "已重置为系统默认配置");
    } catch {
      notify("error", "网络错误，请重试");
    } finally {
      setClearing(false);
    }
  }

  const isbusy = saving || clearing;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Toast */}
      {notification && (
        <div
          className={cn(
            "fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg pointer-events-none",
            notification.type === "success"
              ? "bg-[oklch(0.92_0.08_145)] text-[oklch(0.35_0.10_145)]"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {notification.type === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {notification.msg}
        </div>
      )}

      <div className="max-w-2xl mx-auto w-full px-6 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Settings2 size={20} className="text-primary" />
            LLM 配置
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            为各 AI 角色配置专属的 API Key、接口地址和模型名称。留空则继承系统默认配置（来自服务器 .env）。
          </p>
        </div>

        {/* Info banner */}
        <div className="flex gap-2.5 rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 p-3.5 text-sm text-blue-700 dark:text-blue-300">
          <Info size={15} className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">安全提示</p>
            <p className="text-xs text-blue-600 dark:text-blue-400">
              API Key 以 AES-256-GCM 加密后存储在服务器，前端不会回显完整密钥。
              保存后显示的 <code className="rounded bg-blue-100 dark:bg-blue-900 px-1 py-0.5 text-[10px]">sk-x****</code> 为脱敏预览。
            </p>
          </div>
        </div>

        {/* Role tabs */}
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : (
          <Tabs defaultValue="chat" className="w-full">
            <TabsList className="grid grid-cols-5 w-full h-auto">
              {ROLES.map(({ key, label }) => (
                <TabsTrigger key={key} value={key} className="text-xs py-1.5">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            {ROLES.map(({ key, label, desc }) => (
              <TabsContent key={key} value={key}>
                <div className="rounded-xl border bg-card p-5 space-y-4">
                  <div>
                    <p className="font-medium text-sm">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                  <RolePanel
                    roleKey={key}
                    config={config[key]}
                    onChange={(field, val) => setRoleField(key, field, val)}
                    disabled={isbusy}
                  />
                </div>
              </TabsContent>
            ))}
          </Tabs>
        )}

        {/* Actions */}
        {!loading && (
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              disabled={isbusy}
              className="gap-1.5 text-muted-foreground"
            >
              <RotateCcw size={13} />
              {clearing ? "重置中…" : "全部重置"}
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={isbusy}
              className="gap-1.5 min-w-[88px]"
            >
              <Save size={13} />
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
