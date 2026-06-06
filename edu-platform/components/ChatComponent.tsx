"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  Send,
  Bot,
  AlertCircle,
  Paperclip,
  X,
  FileText,
  Loader2,
  Copy,
  Check,
  Pencil,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useChatStream,
  type AttachmentRef,
  type ChatMessage,
  type MessageTimelineItem,
  type UseChatStreamConfig,
  type ExecutionPayload,
  type Citation,
} from "@/lib/hooks/useChatStream";
import { toolEmoji } from "@/lib/chatToolEmoji";
import { EDU_CHAT_ADD_ATTACHMENT_EVENT } from "@/lib/captureElementToPngFile";
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMathDelimiters,
} from "@/lib/markdownMath";
import { markdownComponents } from "@/lib/markdownComponents";

export type ChatComponentProps =
  | {
      variant?: "course";
      courseId: string;
      hydrateSessionId?: string | null;
      /** ID of the material the user is currently previewing in the dockview. */
      activeMaterialId?: string | null;
      /** Capture the current page as a File for implicit page context on send. */
      captureCurrentPage?: () => Promise<File | null>;
      emptyHint?: string;
    }
  | {
      variant: "qa_center";
      sessionId: string | null;
      onSessionResolved?: (sessionId: string) => void;
      emptyHint?: string;
    }
  | {
      variant: "personal_kb";
      sessionId: string | null;
      activeMaterialId?: string | null;
      emptyHint?: string;
    };

function buildStreamConfig(props: ChatComponentProps): UseChatStreamConfig {
  if (props.variant === "qa_center") {
    return {
      kind: "qa_center_global",
      sessionId: props.sessionId,
      onResolvedSessionId: props.onSessionResolved,
    };
  }
  if (props.variant === "personal_kb") {
    return {
      kind: "personal_kb",
      sessionId: props.sessionId,
      activeMaterialId: props.activeMaterialId ?? null,
    };
  }
  return {
    kind: "course",
    courseId: props.courseId,
    hydrateSessionId: props.hydrateSessionId ?? null,
    activeMaterialId: props.activeMaterialId ?? null,
    captureCurrentPage: props.captureCurrentPage,
  };
}

function defaultEmptyHint(props: ChatComponentProps): string {
  if (props.variant === "qa_center") {
    return "向助手提问，将检索你有权限的全部课程资料";
  }
  if (props.variant === "personal_kb") {
    return "向助手提问，将检索你的个人知识库";
  }
  return "向我提问关于本节课的任何问题";
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function useCopyFeedback() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = (id: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setCopiedId(id);
    timerRef.current = setTimeout(() => setCopiedId(null), 2000);
  };
  return { copiedId, trigger };
}

const CITATION_INLINE_MAX = 3;

/**
 * Pre-process markdown text before rendering:
 * convert bare [N] citation markers (LLM academic style) into markdown links
 * so they get picked up by the `a` component override and rendered as inline dashed citations.
 * Regex skips [N](...) that are already markdown links.
 */
function preprocessCitationMarkers(text: string): string {
  return text.replace(/\[(\d{1,3})\](?!\()/g, (_, n) => `[${n}](#cite-${n})`);
}

/** Inline cited-text span: dashed underline + hover tooltip + click-to-sidebar.
 *  Bare numeric children (from [N]) are normalized to bracketed text like [N]
 *  and rendered with the same dashed style as phrase citations. */
function CitationLink({
  n,
  children,
  citations,
  onCitationClick,
}: {
  n: number;
  children: React.ReactNode;
  citations: Citation[];
  onCitationClick: (c: Citation, idx: number) => void;
}) {
  const citation = citations[n - 1];
  if (!citation) return <>{children}</>;

  // Detect numeric citation markers and normalize them to bracketed text.
  const childStr = typeof children === "string"
    ? children
    : Array.isArray(children)
      ? (children as React.ReactNode[]).map((c) => (typeof c === "string" ? c : "")).join("")
      : "";
  const isBadge = /^\d+$/.test(childStr.trim());
  const displayChildren = isBadge ? `[${n}]` : children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="border-b border-dashed border-primary/50 cursor-pointer hover:border-primary hover:text-primary transition-colors"
          onClick={() => onCitationClick(citation, n - 1)}
        >
          {displayChildren}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="max-w-[260px] p-3 space-y-1.5 bg-popover text-popover-foreground border border-border shadow-md rounded-lg z-50"
      >
        <p className="text-xs font-semibold leading-tight">{citation.source_label ?? `引用 ${n}`}</p>
        {citation.chunk_text && (
          <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
            {citation.chunk_text.slice(0, 120)}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground/60">点击查看详情</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Returns markdown components with an `a` override that renders `[text](#cite-N)` links
 *  as inline citation spans (dashed underline + tooltip) instead of real anchors. */
function makeCitationComponents(
  citations: Citation[],
  onCitationClick: (c: Citation, idx: number) => void,
) {
  return {
    ...markdownComponents,
    a({ href, children }: { href?: string; children?: React.ReactNode }) {
      if (href?.startsWith("#cite-")) {
        const n = parseInt(href.replace("#cite-", ""), 10);
        if (!isNaN(n) && n > 0) {
          return (
            <CitationLink n={n} citations={citations} onCitationClick={onCitationClick}>
              {children}
            </CitationLink>
          );
        }
      }
      return <a href={href}>{children}</a>;
    },
  };
}

/** Horizontally-scrollable citation button bar with a pinned expand button. */
function CitationScrollBar({
  citations,
  onCitationClick,
  onExpandAll,
}: {
  citations: Citation[];
  onCitationClick: (c: Citation, ci: number) => void;
  onExpandAll: () => void;
}) {
  const scrollEl = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false, pointerId: -1, captured: false });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = scrollEl.current;
    if (!el) return;
    // Store state but do NOT call setPointerCapture yet — doing so immediately
    // causes pointerup to fire on scrollEl (not the button), which makes the
    // browser dispatch the click event to scrollEl instead of the child button,
    // so the button's onClick never fires. Capture is deferred until drag starts.
    drag.current = { active: true, startX: e.clientX, scrollLeft: el.scrollLeft, moved: false, pointerId: e.pointerId, captured: false };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    const el = scrollEl.current;
    if (!el) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 4) {
      drag.current.moved = true;
      // Only capture the pointer once the drag threshold is exceeded so that
      // simple clicks are never intercepted by pointer capture.
      if (!drag.current.captured) {
        el.setPointerCapture(drag.current.pointerId);
        drag.current.captured = true;
      }
    }
    el.scrollLeft = drag.current.scrollLeft - dx;
  };

  const handlePointerUp = () => { drag.current.active = false; };

  const handleClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) {
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  return (
    <div className="mt-1.5 flex items-center gap-1 min-w-0 w-full">
      <div
        ref={scrollEl}
        className="flex flex-nowrap items-center gap-1.5 overflow-x-auto flex-1 min-w-0 [&::-webkit-scrollbar]:hidden cursor-grab active:cursor-grabbing select-none"
        style={{ scrollbarWidth: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClickCapture={handleClickCapture}
      >
        {citations.map((c, ci) => (
          <button
            key={ci}
            type="button"
            onClick={() => onCitationClick(c, ci)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/8 px-2.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15 transition-colors"
          >
            <span className="font-mono font-bold opacity-60">[{ci + 1}]</span>
            <span className="max-w-[4em] truncate">{c.source_label ?? `引用 ${ci + 1}`}</span>
          </button>
        ))}
      </div>
      {citations.length > CITATION_INLINE_MAX && (
        <button
          type="button"
          onClick={onExpandAll}
          className="shrink-0 inline-flex items-center rounded-full border border-muted-foreground/30 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/70 transition-colors"
        >
          ···
        </button>
      )}
    </div>
  );
}

export default function ChatComponent(props: ChatComponentProps) {
  const [input, setInput] = useState("");
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string } | null>(null);
  const { copiedId: copiedClientId, trigger: triggerCopyFeedback } = useCopyFeedback();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    msgs,
    streaming,
    toolActivity,
    streamTimeline,
    busy,
    isReflecting,
    citations,
    lastMeta,
    errorMsg,
    sendMessage,
    commitUserEditReplace,
    regenerateAssistantAt,
    navigateBranch,
    branchRecords,
    pendingAttachments,
    attachmentUploading,
    addAttachment,
    removeAttachment,
    pendingApproval,
    respondToApproval,
  } = useChatStream(buildStreamConfig(props));
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const emptyHint = props.emptyHint ?? defaultEmptyHint(props);

  const threadKey =
    props.variant === "qa_center"
      ? props.sessionId ?? ""
      : props.variant === "personal_kb"
      ? `pkb:${props.sessionId ?? ""}`
      : `${props.courseId}:${props.hydrateSessionId ?? ""}`;

  useEffect(() => {
    setEditingClientId(null);
    setEditDraft("");
  }, [threadKey]);

  useEffect(() => {
    if (props.variant === "qa_center") return;
    const onAddAttachment = (ev: Event) => {
      const ce = ev as CustomEvent<{ file?: File }>;
      const f = ce.detail?.file;
      if (f instanceof File) void addAttachment(f);
    };
    window.addEventListener(EDU_CHAT_ADD_ATTACHMENT_EVENT, onAddAttachment);
    return () =>
      window.removeEventListener(EDU_CHAT_ADD_ATTACHMENT_EVENT, onAddAttachment);
  }, [addAttachment, props.variant]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (isAtBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs, streaming, toolActivity, streamTimeline]);

  const handleSend = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || busy) return;
    isAtBottom.current = true;
    void sendMessage(input);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((f) => void addAttachment(f));
    e.target.value = "";
  };

  const startEdit = (msg: ChatMessage) => {
    setEditingClientId(msg.clientId);
    setEditDraft(msg.text);
  };

  const cancelEdit = () => {
    setEditingClientId(null);
    setEditDraft("");
  };

  const submitEdit = (msgIndex: number) => {
    if (busy) return;
    void commitUserEditReplace(msgIndex, editDraft).then((ok) => {
      if (ok) cancelEdit();
    });
  };

  return (
    <div className="flex flex-col h-full bg-background relative">
      <div ref={scrollRef} className="flex-1 min-h-0 w-full px-4 md:px-8 pt-6 pb-4 overflow-y-auto overflow-x-hidden">
        <div className="w-full max-w-none space-y-8 flex flex-col">
          {msgs.length === 0 && !streaming && !busy && (
            <div className="h-[50vh] flex flex-col items-center justify-center text-muted-foreground opacity-50">
              <Bot className="h-16 w-16 mb-4" />
              <p>{emptyHint}</p>
            </div>
          )}

          {msgs.map((msg, i) => {
            const isEditing = editingClientId === msg.clientId;
            const branchRecord = branchRecords.find((r) => r.position === i);
            const hasBranch = !!branchRecord && branchRecord.entries.length > 1;
            return (
              <div key={msg.clientId} className="group flex w-full flex-col">
                <div
                  className={cn(
                    "flex w-full",
                    msg.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "flex min-w-0 flex-col",
                      msg.role === "user"
                        ? "max-w-[min(100%,80%)] items-end"
                        : "w-full min-w-0 items-start",
                    )}
                  >
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div
                      className={cn(
                        "flex flex-wrap gap-1.5 mb-1.5",
                        msg.role === "user" ? "justify-end" : "justify-start",
                      )}
                    >
                      {msg.attachments.map((att) => (
                        <AttachmentBubble
                          key={att.id}
                          att={att}
                          onPreview={(src, name) => setImagePreview({ src, name })}
                        />
                      ))}
                    </div>
                  )}

                  {msg.role === "assistant" && (msg.toolActivity?.length ?? 0) > 0 && !msg.timeline?.length && (
                    <div className="mb-1.5 flex flex-col gap-1">
                      {msg.toolActivity!.map((row, ri) => {
                        if (row.execution) {
                          const fakeItem: Extract<MessageTimelineItem, { kind: "tool" }> & { execution: ExecutionPayload } = {
                            kind: "tool",
                            clientKey: row.clientKey ?? `${msg.clientId}-tc-${ri}`,
                            name: row.name,
                            status: "done",
                            success: row.success,
                            durationMs: row.durationMs,
                            execution: row.execution,
                            input: row.input,
                            output: row.output,
                            meta: row.meta,
                          };
                          return <ExecutionTerminalBlock key={fakeItem.clientKey} item={fakeItem} />;
                        }
                        return (
                        <ToolCallBlock
                          key={row.clientKey ?? `${msg.clientId}-tc-${ri}`}
                          item={{
                            kind: "tool",
                            clientKey: row.clientKey ?? `${msg.clientId}-tc-${ri}`,
                            name: row.name,
                            status: row.status,
                            success: row.success,
                            durationMs: row.durationMs,
                            input: row.input,
                            output: row.output,
                            meta: row.meta,
                          }}
                        />
                        );
                      })}
                    </div>
                  )}

                  <div
                    className={cn(
                      "relative",
                      msg.role === "user"
                        ? "rounded-2xl bg-muted text-foreground rounded-tr-sm"
                        : "rounded-none bg-transparent text-foreground",
                    )}
                  >
                    {msg.role === "user" && isEditing ? (
                      <div className="flex flex-col gap-2 p-3 min-w-[min(100%,280px)]">
                        <Textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          className="min-h-[100px] resize-y text-sm"
                          disabled={busy}
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={busy}>
                            取消
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => submitEdit(i)}
                            disabled={
                              busy ||
                              (!editDraft.trim() && (msg.attachments?.length ?? 0) === 0)
                            }
                          >
                            发送
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "px-4 py-3",
                          msg.role === "assistant" &&
                            "prose prose-sm dark:prose-invert max-w-none [&_pre]:border-0 [&_.katex-display]:overflow-x-auto",
                        )}
                      >
                        {msg.role === "user" ? (
                          <div className="whitespace-pre-wrap">{msg.text}</div>
                        ) : msg.timeline?.length ? (
                          <AssistantTimeline
                            items={msg.timeline}
                            isLive={false}
                            citations={msg.citations ?? []}
                            onCitationClick={(c, ci) => {
                              window.dispatchEvent(
                                new CustomEvent("edu:open-material-preview", {
                                  detail: {
                                    materialId: c.material_id,
                                    chunkId: c.chunk_id,
                                    sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                                    chunkText: c.chunk_text,
                                    image_urls: c.image_urls,
                                  },
                                }),
                              );
                            }}
                          />
                        ) : (
                          <TooltipProvider delayDuration={300}>
                            <ReactMarkdown
                              remarkPlugins={markdownRemarkPlugins}
                              rehypePlugins={markdownRehypePlugins}
                              components={makeCitationComponents(
                                msg.citations ?? [],
                                (c, ci) => {
                                  window.dispatchEvent(
                                    new CustomEvent("edu:open-material-preview", {
                                      detail: {
                                        materialId: c.material_id,
                                        chunkId: c.chunk_id,
                                        sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                                        chunkText: c.chunk_text,
                                        image_urls: c.image_urls,
                                      },
                                    }),
                                  );
                                }
                              )}
                            >
                              {normalizeMathDelimiters(preprocessCitationMarkers(msg.text))}
                            </ReactMarkdown>
                          </TooltipProvider>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Branch navigation arrows — shown below each message bubble */}
                  {hasBranch && !isEditing && (
                    <div
                      className={cn(
                        "flex items-center gap-0.5 mt-0.5 text-xs text-muted-foreground",
                        msg.role === "user" ? "justify-end" : "justify-start",
                      )}
                    >
                      <button
                        type="button"
                        disabled={branchRecord.activeIdx === 0 || busy}
                        onClick={() => navigateBranch(i, -1)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-muted disabled:opacity-30 transition-colors"
                        aria-label="上一个版本"
                      >
                        <ChevronLeft size={13} />
                      </button>
                      <span className="tabular-nums px-0.5 select-none">
                        {branchRecord.activeIdx + 1}&thinsp;/&thinsp;{branchRecord.entries.length}
                      </span>
                      <button
                        type="button"
                        disabled={branchRecord.activeIdx === branchRecord.entries.length - 1 || busy}
                        onClick={() => navigateBranch(i, 1)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-muted disabled:opacity-30 transition-colors"
                        aria-label="下一个版本"
                      >
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  )}

                  <div
                    className={cn(
                      "mt-1 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100",
                      msg.role === "user" ? "flex-row-reverse" : "flex-row",
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      aria-label="复制消息"
                      onClick={() => {
                        void copyToClipboard(msg.text)
                          .then(() => triggerCopyFeedback(msg.clientId))
                          .catch(() => {});
                      }}
                    >
                      {copiedClientId === msg.clientId ? (
                        <Check size={14} strokeWidth={2} className="text-emerald-500" />
                      ) : (
                        <Copy size={14} strokeWidth={2} />
                      )}
                    </Button>
                    {msg.role === "user" && !isEditing && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        disabled={busy}
                        aria-label="编辑消息"
                        onClick={() => startEdit(msg)}
                      >
                        <Pencil size={14} strokeWidth={2} />
                      </Button>
                    )}
                    {msg.role === "assistant" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        disabled={busy}
                        aria-label="重新生成"
                        onClick={() => void regenerateAssistantAt(i)}
                      >
                        <RefreshCw size={14} strokeWidth={2} />
                      </Button>
                    )}
                  </div>
                  {/* Historical citations (loaded from DB) — after reply text */}
                  {msg.role === "assistant" && (msg.citations?.length ?? 0) > 0 && (
                    <CitationScrollBar
                      citations={msg.citations!}
                      onCitationClick={(c, ci) => {
                        window.dispatchEvent(
                          new CustomEvent("edu:open-material-preview", {
                            detail: {
                              materialId: c.material_id,
                              chunkId: c.chunk_id,
                              sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                              chunkText: c.chunk_text,
                              image_urls: c.image_urls,
                            },
                          }),
                        );
                      }}
                      onExpandAll={() => {
                        window.dispatchEvent(
                          new CustomEvent("edu:open-citation-list", {
                            detail: msg.citations!.map((c, ci) => ({
                              materialId: c.material_id,
                              chunkId: c.chunk_id,
                              sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                              chunkText: c.chunk_text,
                              image_urls: c.image_urls,
                            })),
                          }),
                        );
                      }}
                    />
                  )}
                </div>
              </div>
              </div>
            );
          })}

          {busy && (
            <div className="group flex w-full flex-col gap-2 pl-4">
              {streamTimeline.length > 0 ? (
                <div className="flex w-full justify-start">
                  <div className="flex min-w-0 w-full flex-col items-start">
                    <div className="rounded-none px-4 py-3 bg-transparent text-foreground prose prose-sm dark:prose-invert max-w-none [&_pre]:border-0 [&_.katex-display]:overflow-x-auto">
                      <AssistantTimeline
                        items={streamTimeline}
                        isLive={true}
                        isReflecting={isReflecting}
                        citations={citations}
                        onCitationClick={(c, ci) => {
                          window.dispatchEvent(
                            new CustomEvent("edu:open-material-preview", {
                              detail: {
                                materialId: c.material_id,
                                chunkId: c.chunk_id,
                                sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                                chunkText: c.chunk_text,
                                image_urls: c.image_urls,
                              },
                            }),
                          );
                        }}
                      />
                    </div>
                    {streaming.length > 0 && (
                      <div className="mt-1 flex opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          aria-label="复制正在生成的内容"
                          onClick={() => {
                            void copyToClipboard(streaming)
                              .then(() => triggerCopyFeedback("streaming"))
                              .catch(() => {});
                          }}
                        >
                          {copiedClientId === "streaming" ? (
                            <Check size={14} strokeWidth={2} className="text-emerald-500" />
                          ) : (
                            <Copy size={14} strokeWidth={2} />
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                  <span>思考中…</span>
                </div>
              )}
            </div>
          )}

          {(citations.length > 0 || lastMeta) && (
            <div className="flex w-full justify-start pl-0">
              <div className="space-y-1.5">
                {citations.length > 0 && (
                  <CitationScrollBar
                    citations={citations}
                    onCitationClick={(c, ci) => {
                      window.dispatchEvent(
                        new CustomEvent("edu:open-material-preview", {
                          detail: {
                            materialId: c.material_id,
                            chunkId: c.chunk_id,
                            sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                            chunkText: c.chunk_text,
                            image_urls: c.image_urls,
                          },
                        }),
                      );
                    }}
                    onExpandAll={() => {
                      window.dispatchEvent(
                        new CustomEvent("edu:open-citation-list", {
                          detail: citations.map((c, ci) => ({
                            materialId: c.material_id,
                            chunkId: c.chunk_id,
                            sourceLabel: c.source_label ?? `引用 ${ci + 1}`,
                            chunkText: c.chunk_text,
                            image_urls: c.image_urls,
                          })),
                        }),
                      );
                    }}
                  />
                )}
                {lastMeta?.type === "done" && !lastMeta.error && lastMeta.exec_time_ms && (
                  <p className="text-[10px] text-muted-foreground/60">{lastMeta.exec_time_ms} ms</p>
                )}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="flex w-full justify-center">
              <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-1.5 rounded-full">
                <AlertCircle size={14} />
                <span>{errorMsg}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 w-full px-4 md:px-8 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4">
        {/* ---- Tool Approval Card ---- */}
        {pendingApproval && (
          <div className="mb-3 rounded-xl border border-amber-300/70 bg-amber-50/80 dark:border-amber-700/60 dark:bg-amber-950/40 px-4 py-3 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-lg" aria-hidden>
                {toolEmoji(pendingApproval.toolName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  AI 请求执行操作：
                  <code className="ml-1.5 rounded bg-amber-200/60 dark:bg-amber-800/60 px-1.5 py-0.5 font-mono text-xs">
                    {pendingApproval.toolName}
                  </code>
                </p>
                <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
                  {pendingApproval.reason}
                </p>
                {Object.keys(pendingApproval.argsPreview).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-amber-700/70 dark:text-amber-400/70 select-none hover:text-amber-900 dark:hover:text-amber-200">
                      查看参数
                    </summary>
                    <pre className="mt-1.5 overflow-auto rounded bg-amber-100/60 dark:bg-amber-900/40 p-2 text-[11px] leading-relaxed text-foreground/80">
                      {JSON.stringify(pendingApproval.argsPreview, null, 2)}
                    </pre>
                  </details>
                )}
                {pendingApproval.fullCode && (
                  <details className="mt-2" open>
                    <summary className="cursor-pointer text-xs text-amber-700/70 dark:text-amber-400/70 select-none hover:text-amber-900 dark:hover:text-amber-200">
                      代码预览
                    </summary>
                    <pre className="mt-1.5 overflow-auto max-h-64 rounded bg-zinc-950/80 dark:bg-zinc-950/60 p-2 text-[11px] leading-relaxed text-zinc-200 font-mono">
                      {pendingApproval.fullCode}
                    </pre>
                  </details>
                )}
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-amber-400/60 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/60"
                onClick={() => void respondToApproval(false)}
              >
                拒绝
              </Button>
              <Button
                type="button"
                size="sm"
                className="bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
                onClick={() => void respondToApproval(true)}
              >
                允许
              </Button>
            </div>
          </div>
        )}
        <div className="w-full max-w-none relative rounded-2xl bg-muted/40 border border-border shadow-sm focus-within:ring-1 focus-within:ring-ring focus-within:bg-background transition-colors overflow-hidden">
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
              {pendingAttachments.map((att) => (
                <div key={att.id} className="relative group flex-shrink-0">
                  {att.mime_type.startsWith("image/") && att.localPreviewUrl ? (
                    <Image
                      src={att.localPreviewUrl}
                      alt={att.name}
                      width={64}
                      height={64}
                      unoptimized
                      className="w-16 h-16 object-cover rounded-lg border border-border"
                    />
                  ) : (
                    <div className="w-16 h-16 flex flex-col items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground gap-1 px-1">
                      <FileText size={20} className="shrink-0" />
                      <span className="truncate w-full text-center leading-tight">{att.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-foreground text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="移除附件"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end">
            <div className="pl-2 pb-2 flex-shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.py,.js,.ts,.mjs"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "h-8 w-8 rounded-full text-muted-foreground hover:text-foreground",
                  attachmentUploading && "opacity-50",
                )}
                onClick={() => fileInputRef.current?.click()}
                disabled={attachmentUploading || busy}
                aria-label="上传附件"
              >
                {attachmentUploading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Paperclip size={16} />
                )}
              </Button>
            </div>
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onKeyDown={handleKeyDown}
              placeholder="请输入..."
              className="min-h-[52px] max-h-48 resize-none border-0 shadow-none bg-transparent py-4 text-sm focus-visible:ring-0 flex-1"
              disabled={busy}
              rows={1}
            />
            <div className="pr-2 pb-2 flex-shrink-0">
              <Button
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full",
                  ((!input.trim() && pendingAttachments.length === 0) || busy) && "opacity-50",
                )}
                onClick={handleSend}
                disabled={(!input.trim() && pendingAttachments.length === 0) || busy}
              >
                <Send size={16} />
              </Button>
            </div>
          </div>
        </div>
        <div className="text-center mt-2 text-xs text-muted-foreground">
          EduAgent 可能会犯错。请补充核实。
        </div>
      </div>

      {imagePreview && (
        <div
          className="fixed inset-0 z-[100] bg-black/75 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="附件图片预览"
          onClick={() => setImagePreview(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/15 text-white hover:bg-white/25 inline-flex items-center justify-center"
            onClick={() => setImagePreview(null)}
            aria-label="关闭预览"
          >
            <X size={16} />
          </button>
          <div
            className="relative max-w-[92vw] max-h-[88vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <Image
              src={imagePreview.src}
              alt={imagePreview.name}
              width={1600}
              height={1200}
              unoptimized
              className="max-w-[92vw] max-h-[88vh] h-auto w-auto rounded-lg shadow-2xl"
            />
            <p className="mt-2 text-center text-xs text-white/85 break-all">
              {imagePreview.name}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible terminal output block shown after run_script executes.
 * Mirrors the "Executed" block style from Cursor/ChatGPT.
 */

/** Friendly display labels for known tool names. */
const TOOL_LABELS: Record<string, string> = {
  knowledge_query: "知识库检索",
  web_search: "网络搜索",
  ollama_web_search: "网络搜索",
  wikipedia_search: "维基百科搜索",
  remember_fact: "记忆存储",
  search_memory: "记忆检索",
  get_course_info: "获取课程信息",
  list_course_materials: "列出课程资料",
  get_material_summary: "获取资料摘要",
  delegate_task: "委派子任务",
  read_attachment: "读取附件",
  build_mindmap: "构建思维导图",
  generate_quiz: "生成练习题",
  parse_document: "解析文档",
};

/** Formats a single input value for display. */
function formatInputValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return (v as unknown[]).join(", ");
  return JSON.stringify(v);
}

/** Expandable tool call card for all non-script tools. */
function ToolCallBlock({
  item,
}: {
  item: Extract<MessageTimelineItem, { kind: "tool" }>;
}) {
  const hasDetails =
    (item.input !== undefined && Object.keys(item.input).length > 0) ||
    (item.output !== undefined && item.output.trim().length > 0) ||
    item.meta !== undefined;
  const [open, setOpen] = useState(false);

  const meta = item.meta;
  const decomposed = meta?.decomposed === true;
  const subQueries =
    decomposed && Array.isArray(meta?.sub_queries) ? (meta.sub_queries as string[]) : [];
  const rewritten = meta?.rewritten === true;
  const rewrittenQuery =
    typeof meta?.rewritten_query === "string" ? meta.rewritten_query : undefined;
  const hitCount = typeof meta?.hit_count === "number" ? meta.hit_count : undefined;

  const label = TOOL_LABELS[item.name] ?? item.name;

  return (
    <div className="my-1.5 rounded-md border border-border/60 bg-muted/40 overflow-hidden not-prose text-xs">
      {/* Header row */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 px-2.5 py-1.5",
          hasDetails && "cursor-pointer hover:bg-muted/60 transition-colors select-none",
        )}
        onClick={hasDetails ? () => setOpen((v) => !v) : undefined}
        role={hasDetails ? "button" : undefined}
        aria-expanded={hasDetails ? open : undefined}
      >
        <span className="tabular-nums" aria-hidden>
          {toolEmoji(item.name)}
        </span>
        <span className="font-mono text-foreground/90">{label}</span>
        {item.status === "running" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70" aria-label="执行中" />
            {item.progressLabel && (
              <span className="text-muted-foreground opacity-80 truncate max-w-[240px]">
                {item.progressLabel}
              </span>
            )}
          </>
        ) : (
          <span className="flex items-center gap-1">
            <span
              className={
                item.success === false
                  ? "text-destructive"
                  : item.success === true
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
              }
            >
              {item.success === false ? "✗" : item.success === true ? "✓" : "?"}
            </span>
            {typeof item.durationMs === "number" && (
              <span className="ml-0.5 text-muted-foreground opacity-80">
                {(item.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </span>
        )}
        {/* Metadata badges */}
        {decomposed && (
          <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-700 dark:text-blue-300 font-medium">
            子查询×{subQueries.length}
          </span>
        )}
        {rewritten && !decomposed && (
          <span className="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300 font-medium">
            查询改写
          </span>
        )}
        {typeof hitCount === "number" && !decomposed && !rewritten && (
          <span className="text-muted-foreground opacity-70">{hitCount} 条</span>
        )}
        {hasDetails && (
          <span className="ml-auto shrink-0 text-muted-foreground">
            {open ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            )}
          </span>
        )}
      </div>

      {/* Expandable details */}
      {open && hasDetails && (
        <div className="border-t border-border/40 bg-background/60 px-3 py-2.5 space-y-2.5 text-[11px] leading-relaxed">
          {/* Input params */}
          {item.input && Object.keys(item.input).length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-[10px] uppercase tracking-wide">
                调用参数
              </p>
              <dl className="space-y-0.5">
                {Object.entries(item.input).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-muted-foreground shrink-0 w-28 truncate font-mono">{k}</dt>
                    <dd className="text-foreground/90 break-all">{formatInputValue(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Sub-query decomposition */}
          {decomposed && subQueries.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-[10px] uppercase tracking-wide">
                子查询分解
              </p>
              <ol className="space-y-0.5 list-decimal list-inside">
                {subQueries.map((q, i) => (
                  <li key={i} className="text-foreground/90">
                    {q}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Query rewrite */}
          {rewritten && rewrittenQuery && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-[10px] uppercase tracking-wide">
                查询改写
              </p>
              <p className="text-foreground/90">{rewrittenQuery}</p>
            </div>
          )}

          {/* Output */}
          {item.output && item.output.trim().length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-[10px] uppercase tracking-wide">
                调用结果
              </p>
              <pre className="whitespace-pre-wrap break-words text-foreground/80 max-h-48 overflow-auto bg-muted/40 rounded px-2 py-1.5 font-mono">
                {item.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExecutionTerminalBlock({  item,
}: {
  item: Extract<MessageTimelineItem, { kind: "tool" }> & { execution: ExecutionPayload };
}) {
  const { execution, durationMs } = item;
  const [open, setOpen] = useState(execution.return_code !== 0);
  const [copied, setCopied] = useState(false);

  const fullOutput = [
    execution.stdout,
    execution.stderr,
  ].filter(Boolean).join("\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  return (
    <div className="my-1.5 rounded-md border border-border/60 bg-muted/30 overflow-hidden not-prose text-xs font-mono">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/60 transition-colors text-left"
        aria-expanded={open}
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-foreground/90">Executed</span>
        <span className="text-muted-foreground truncate flex-1">·&nbsp;{execution.command}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            execution.return_code !== 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          exit&nbsp;{execution.return_code}
        </span>
        {typeof durationMs === "number" && (
          <span className="shrink-0 text-muted-foreground opacity-70">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>

      {/* Collapsible content */}
      {open && (
        <div className="border-t border-border/40 bg-zinc-950/80 dark:bg-zinc-950/60">
          <div className="flex items-center justify-between px-2.5 py-1 border-b border-border/20">
            <span className="text-muted-foreground/60 text-[10px]">$ {execution.command}</span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/40"
              aria-label="复制全部输出"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
          </div>
          <pre className="overflow-auto max-h-80 px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
            {execution.stdout && (
              <span className="text-zinc-200">{execution.stdout}</span>
            )}
            {execution.stderr && (
              <span className="text-red-400">{execution.stderr}</span>
            )}
            {!execution.stdout && !execution.stderr && (
              <span className="text-muted-foreground italic">(无输出)</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Renders an interleaved timeline of text chunks and tool call cards.
 * Used for both live streaming (isLive=true) and historical messages (isLive=false).
 */
function AssistantTimeline({
  items,
  isLive,
  isReflecting,
  citations,
  onCitationClick,
}: {
  items: MessageTimelineItem[];
  isLive: boolean;
  isReflecting?: boolean;
  citations?: Citation[];
  onCitationClick?: (c: Citation, idx: number) => void;
}) {
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
  // Show a thinking spinner when busy but no events have arrived yet,
  // or when waiting for LLM to respond after a tool result.
  const showThinking =
    isLive &&
    (items.length === 0 ||
      (lastItem?.kind === "tool" && lastItem.status === "done"));

  // Determine the spinner label
  const thinkingLabel = isReflecting ? "正在验证结果…" : "思考中…";

  return (
    <TooltipProvider delayDuration={300}>
    <>
      {items.map((item, i) => {
        if (item.kind === "text") {
          const isLastAndLive = isLive && i === items.length - 1;
          return (
            // Key by index: consecutive text items are merged, so index is stable per position.
            <span key={`text-${i}`} className="contents">
              <ReactMarkdown
                remarkPlugins={markdownRemarkPlugins}
                rehypePlugins={markdownRehypePlugins}
                components={
                  citations && onCitationClick
                    ? makeCitationComponents(citations, onCitationClick)
                    : markdownComponents
                }
              >
                {normalizeMathDelimiters(preprocessCitationMarkers(item.content))}
              </ReactMarkdown>
              {isLastAndLive && (
                <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
              )}
            </span>
          );
        }
        // Tool item
        if (item.execution) {
          return (
            <ExecutionTerminalBlock
              key={item.clientKey}
              item={item as Extract<MessageTimelineItem, { kind: "tool" }> & { execution: ExecutionPayload }}
            />
          );
        }
        return (
          <ToolCallBlock
            key={item.clientKey}
            item={item}
          />
        );
      })}
      {showThinking && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground not-prose"
          aria-live="polite"
          aria-busy="true"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <span>{thinkingLabel}</span>
        </div>
      )}
    </>
    </TooltipProvider>
  );
}

function AttachmentBubble({
  att,
  onPreview,
}: {
  att: AttachmentRef;
  onPreview?: (src: string, name: string) => void;
}) {
  const imgSrc =
    att.mime_type.startsWith("image/") && (att.localPreviewUrl ?? att.presigned_url)
      ? (att.localPreviewUrl ?? att.presigned_url)
      : null;

  if (imgSrc) {
    return (
      <button
        type="button"
        className="rounded-xl overflow-hidden border border-border hover:opacity-90 transition-opacity"
        onClick={() => onPreview?.(imgSrc, att.name)}
        aria-label={`预览附件：${att.name}`}
      >
        <Image
          src={imgSrc}
          alt={att.name}
          width={200}
          height={200}
          unoptimized
          className="max-w-[200px] max-h-[200px] rounded-xl object-cover"
        />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2 text-sm text-muted-foreground max-w-[200px]">
      <FileText size={16} className="shrink-0" />
      <span className="truncate">{att.name}</span>
    </div>
  );
}
