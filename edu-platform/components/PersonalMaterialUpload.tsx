"use client";

import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Upload, CheckCircle2, AlertCircle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatApiErrorFromResponse } from "@/lib/http/format-api-error";
import {
  MATERIAL_UPLOAD_ACCEPT,
  MATERIAL_UPLOAD_ALLOWED_EXT_SET,
  materialUploadAllowedLabel,
} from "@/lib/material-upload-allowed";

type Props = {
  onUploaded?: () => void;
};

function parseExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0) return "";
  return filename.slice(i + 1).toLowerCase();
}

export default function PersonalMaterialUpload({ onUploaded }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Upload size={14} />
          上传资料
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card border border-border shadow-xl p-6 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <UploadForm
            onUploaded={() => {
              onUploaded?.();
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UploadForm({
  onUploaded,
  onClose,
}: {
  onUploaded: () => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textOnly, setTextOnly] = useState(true);
  const [skipKg, setSkipKg] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
    setSuccess(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const ext = parseExtension(file.name);
    if (!MATERIAL_UPLOAD_ALLOWED_EXT_SET.has(ext)) {
      setError(`不支持的文件类型 .${ext}，允许: ${materialUploadAllowedLabel()}`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("text_only", textOnly ? "true" : "false");
      form.append("skip_kg", skipKg ? "true" : "false");
      const res = await fetch("/api/v1/me/materials", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        setError(formatApiErrorFromResponse(res.status, await res.text()));
        return;
      }
      setSuccess(true);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Dialog.Title className="text-base font-semibold">上传到个人知识库</Dialog.Title>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X size={18} />
        </button>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2.5 rounded-xl border border-border px-3 py-2.5 text-xs cursor-pointer hover:bg-muted/20 transition-colors">
          <input
            type="checkbox"
            checked={textOnly}
            disabled={uploading}
            onChange={(e) => setTextOnly(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
          />
          <div>
            <p className="font-medium text-foreground">仅文本索引</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">开启后跳过图片、表格、公式等多模态块</p>
          </div>
        </label>
        <label className="flex items-start gap-2.5 rounded-xl border border-border px-3 py-2.5 text-xs cursor-pointer hover:bg-muted/20 transition-colors">
          <input
            type="checkbox"
            checked={skipKg}
            disabled={uploading}
            onChange={(e) => setSkipKg(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
          />
          <div>
            <p className="font-medium text-foreground">关闭实体与关系提取</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">不做知识图谱抽取，只写入向量索引</p>
          </div>
        </label>
      </div>

      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 transition-colors cursor-pointer",
          file ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/30",
        )}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={MATERIAL_UPLOAD_ACCEPT}
          className="sr-only"
          onChange={handleFileChange}
        />
        <Upload size={22} className="mb-2 text-muted-foreground" />
        {file ? (
          <p className="text-sm text-center font-medium truncate max-w-xs">{file.name}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground text-center">点击选择或拖拽文件</p>
            <p className="text-[11px] text-muted-foreground/70 mt-1 text-center">{materialUploadAllowedLabel()}</p>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400">
          <CheckCircle2 size={13} className="shrink-0" />
          上传成功，正在处理…
        </div>
      )}

      <button
        type="submit"
        disabled={!file || uploading}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
          "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {uploading && <Loader2 size={14} className="animate-spin" />}
        {uploading ? "上传中…" : "上传"}
      </button>
    </form>
  );
}
