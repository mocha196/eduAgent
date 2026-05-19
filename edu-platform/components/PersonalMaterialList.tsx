"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isOfficeMaterialFileType } from "@/lib/material-office";
import { cn } from "@/lib/utils";

export type PersonalMaterialRow = {
  id: string;
  filename: string;
  file_type: string;
  status: string;
  preview_pdf_status: "NA" | "PENDING" | "READY" | "FAILED";
  indexed_chunk_count: number;
  created_at: string;
  status_message: string | null;
};

type Props = {
  activeMaterialId: string | null;
  onPickMaterial: (id: string) => void;
};

const PROCESSING_STATUSES = new Set(["UPLOADED", "PARSING", "PARSED", "INDEXING"]);

export default function PersonalMaterialList({ activeMaterialId, onPickMaterial }: Props) {
  const [materials, setMaterials] = useState<PersonalMaterialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/me/materials", { credentials: "include" });
      if (!res.ok) { setMaterials([]); return; }
      const data = (await res.json()) as { materials: PersonalMaterialRow[] };
      setMaterials(data.materials ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelMaterial = useCallback(async (materialId: string) => {
    setCancellingIds((prev) => new Set(prev).add(materialId));
    try {
      await fetch(`/api/v1/me/materials/${materialId}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      await load();
    } finally {
      setCancellingIds((prev) => { const s = new Set(prev); s.delete(materialId); return s; });
    }
  }, [load]);

  const deleteMaterial = useCallback(async (materialId: string) => {
    if (!confirm("确定要删除这个资料吗？")) return;
    await fetch(`/api/v1/me/materials/${materialId}`, {
      method: "DELETE",
      credentials: "include",
    });
    await load();
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  const hasProcessing = materials.some((m) => PROCESSING_STATUSES.has(m.status));
  useEffect(() => {
    if (!hasProcessing) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [hasProcessing, load]);

  const filtered = useMemo(() => {
    if (!q.trim()) return materials;
    const lower = q.toLowerCase();
    return materials.filter((m) => m.filename.toLowerCase().includes(lower));
  }, [materials, q]);

  return (
    <div className="flex flex-col h-full gap-2 p-2">
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-7 h-7 text-xs"
          placeholder="搜索资料…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setQ("")}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {loading && materials.length === 0 ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          {q ? "没有匹配的资料" : "暂无上传资料"}
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-1">
            {filtered.map((m) => {
              const processing = PROCESSING_STATUSES.has(m.status);
              const failed = m.status === "FAILED";
              const ready = m.status === "READY";
              const isActive = m.id === activeMaterialId;
              const cancelling = cancellingIds.has(m.id);
              return (
                <div
                  key={m.id}
                  className={cn(
                    "group flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                    isActive ? "bg-primary/10 text-primary" : "hover:bg-muted/60",
                  )}
                  onClick={() => onPickMaterial(m.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{m.filename}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {processing && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Loader2 size={10} className="animate-spin" />
                          {m.status === "INDEXING" ? "索引中" : "处理中"}
                        </span>
                      )}
                      {ready && (
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                          已就绪 · {m.indexed_chunk_count} 块
                        </span>
                      )}
                      {failed && (
                        <span className="text-[10px] text-destructive truncate max-w-[120px]">
                          失败
                        </span>
                      )}
                      {isOfficeMaterialFileType(m.file_type) && m.preview_pdf_status === "PENDING" && (
                        <span className="text-[9px] text-muted-foreground">预览生成中</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {processing && !cancelling && (
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-destructive px-1"
                        onClick={(e) => { e.stopPropagation(); void cancelMaterial(m.id); }}
                      >
                        取消
                      </button>
                    )}
                    {(ready || failed) && (
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-destructive px-1"
                        onClick={(e) => { e.stopPropagation(); void deleteMaterial(m.id); }}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
