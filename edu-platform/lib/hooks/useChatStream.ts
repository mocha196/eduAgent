"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseB3SseEventJson,
  type B3CitationEvent,
  type B3SseEvent,
  type ExecutionPayload,
} from "@/lib/agent/b3-protocol";

export type { ExecutionPayload };

/**
 * A single item in the interleaved assistant message timeline.
 * Text and tool events are stored in chronological order so the UI can
 * render them inline rather than as a separate header block.
 */
export type MessageTimelineItem =
  | { kind: "text"; content: string }
  | {
      kind: "tool";
      clientKey: string;
      name: string;
      status: "running" | "done";
      success?: boolean;
      durationMs?: number;
      execution?: ExecutionPayload;
      /** Tool input arguments captured from the tool_call SSE event. */
      input?: Record<string, unknown>;
      /** Tool output text captured from the tool_result SSE event (truncated to 500 chars). */
      output?: string;
      /** Structured metadata from the tool (e.g. decomposition info for knowledge_query). */
      meta?: Record<string, unknown>;
      /** Real-time progress label emitted by the tool while running. */
      progressLabel?: string;
    };

export type ChatMessage = {
  clientId: string;
  role: "user" | "assistant";
  text: string;
  attachments?: AttachmentRef[];
  /** Same QaLog row id for hydrated user/assistant pair */
  qaLogId?: string;
  /** Interleaved timeline of text chunks and tool events (new messages). */
  timeline?: MessageTimelineItem[];
  /** Tool calls recorded during this turn (populated from history, legacy). */
  toolActivity?: ToolActivityItem[];
  /** Citations recorded during this turn (populated from history) */
  citations?: Citation[];
};

/**
 * A single branch snapshot stored when the user edits a message or regenerates a reply.
 * `tailMsgs` contains the msgs array starting from the branch position (inclusive).
 */
export type BranchEntry = {
  tailMsgs: ChatMessage[];
};

/**
 * Branch history for a specific position in the msgs array.
 * `position` is the 0-based index of the message (user msg for edits, assistant msg for regen).
 */
export type BranchRecord = {
  position: number;
  entries: BranchEntry[];
  activeIdx: number;
};

export type Citation = Pick<
  B3CitationEvent,
  "chunk_id" | "material_id" | "source_label" | "chunk_text" | "image_urls"
>;
export type DoneMeta = Extract<B3SseEvent, { type: "done" }>;

/** In-flight tool row for the current assistant turn (not persisted). */
export type ToolActivityItem = {
  clientKey: string;
  name: string;
  status: "running" | "done";
  success?: boolean;
  durationMs?: number;
  execution?: ExecutionPayload;
  input?: Record<string, unknown>;
  output?: string;
  meta?: Record<string, unknown>;
};

/** Pending tool-approval request emitted by the ReAct loop. */
export type PendingApprovalState = {
  toolCallId: string;
  toolName: string;
  argsPreview: Record<string, unknown>;
  approvalKey: string;
  reason: string;
  /** Full un-truncated code for run_script approvals */
  fullCode?: string;
};

export type AttachmentRef = {
  id: string;
  key: string;
  presigned_url: string;
  mime_type: string;
  name: string;
  size: number;
  localPreviewUrl?: string;
};

export type UseChatStreamConfig =
  | {
      kind: "course";
      courseId: string;
      /** When set, load historical Q/A from QA center API into the transcript. */
      hydrateSessionId?: string | null;
      /** ID of the material the user is currently previewing. Sent as material_id in chat requests. */
      activeMaterialId?: string | null;
      /**
       * When provided, called just before each message send to silently capture the current
       * page view. The resulting file is uploaded and sent as current_page_image (not shown in UI).
       */
      captureCurrentPage?: () => Promise<File | null>;
    }
  | {
      kind: "qa_center_global";
      sessionId: string | null;
      onResolvedSessionId?: (id: string) => void;
    }
  | {
      kind: "personal_kb";
      /** Session ID resolved from /api/v1/me/personal-kb/session (pass null while loading). */
      sessionId: string | null;
      /** ID of the material the user is currently previewing. Sent as material_id in chat requests. */
      activeMaterialId?: string | null;
    };

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  // Code files (browser may report these before server normalises to text/plain)
  "text/x-python",
  "application/x-python",
  "application/x-python-code",
  "text/x-javascript",
  "application/javascript",
  "text/javascript",
  "text/typescript",
  "text/x-typescript",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024;

type ApiErrJson = {
  error?: { message?: string };
};

function formatChatHttpError(status: number, body: ApiErrJson): string {
  const raw = (body.error?.message ?? "").trim();
  return raw || `请求失败 (${status})`;
}

function newClientId(): string {
  return crypto.randomUUID();
}

type HydratedRow = {
  id?: string;
  question: string;
  answer: string | null;
  tool_calls?: unknown[];
  citations?: unknown[];
  timeline_json?: unknown[];
};

function logToMsgs(rows: HydratedRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    const qaLogId = typeof r.id === "string" && r.id ? r.id : undefined;
    out.push({
      clientId: newClientId(),
      role: "user",
      text: r.question,
      ...(qaLogId ? { qaLogId } : {}),
    });
    if (r.answer) {
      out.push({
        clientId: newClientId(),
        role: "assistant",
        text: r.answer,
        ...(qaLogId ? { qaLogId } : {}),
        ...(Array.isArray(r.timeline_json) && r.timeline_json.length > 0
          ? { timeline: r.timeline_json as MessageTimelineItem[] }
          : {
              toolActivity: Array.isArray(r.tool_calls)
                ? (r.tool_calls as ToolActivityItem[])
                : [],
            }),
        citations: Array.isArray(r.citations)
          ? (r.citations as Citation[])
          : [],
      });
    }
  }
  return out;
}

function mapAttachmentsForPayload(refs: AttachmentRef[]) {
  return refs.map(({ id, key, presigned_url, mime_type, name }) => ({
    id,
    key,
    presigned_url,
    mime_type,
    name,
  }));
}

export function useChatStream(config: UseChatStreamConfig) {
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const msgsRef = useRef<ChatMessage[]>([]);
  msgsRef.current = msgs;

  const [streaming, setStreaming] = useState<string>("");
  const [toolActivity, setToolActivity] = useState<ToolActivityItem[]>([]);
  const toolSeqRef = useRef(0);
  const streamTimelineRef = useRef<MessageTimelineItem[]>([]);
  const [streamTimeline, setStreamTimeline] = useState<MessageTimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [lastMeta, setLastMeta] = useState<DoneMeta | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [branchRecords, setBranchRecords] = useState<BranchRecord[]>([]);
  const branchRecordsRef = useRef<BranchRecord[]>([]);
  branchRecordsRef.current = branchRecords;

  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [isReflecting, setIsReflecting] = useState(false);
  const pendingApprovalRef = useRef<PendingApprovalState | null>(null);
  pendingApprovalRef.current = pendingApproval;

  /** Update branch records atomically (keeps ref in sync). */
  const updateBranchRecords = useCallback(
    (updater: (prev: BranchRecord[]) => BranchRecord[]) => {
      const next = updater(branchRecordsRef.current);
      branchRecordsRef.current = next;
      setBranchRecords(next);
    },
    [],
  );

  /**
   * Respond to a pending tool approval request.
   * Sends the user's decision to the server, which signals the paused ReAct loop.
   */
  const respondToApproval = useCallback(async (approved: boolean) => {
    const current = pendingApprovalRef.current;
    if (!current) return;
    try {
      await fetch("/api/v1/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ approval_key: current.approvalKey, approved }),
      });
    } catch {
      // The approval loop will time out on its own; nothing critical to handle here
    }
  }, []);

  const historyLoadKey =
    config.kind === "qa_center_global"
      ? `q:${config.sessionId ?? ""}`
      : config.kind === "personal_kb"
      ? `pkb:${config.sessionId ?? ""}`
      : `c:${config.courseId}:h:${config.hydrateSessionId ?? ""}`;

  useEffect(() => {
    // Clear branch history whenever we switch threads
    branchRecordsRef.current = [];
    setBranchRecords([]);

    const c = cfgRef.current;
    if (c.kind === "qa_center_global") {
      if (!c.sessionId) {
        setMsgs([]);
        return;
      }
      const sid = c.sessionId;
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(
            `/api/v1/me/chat-threads/${encodeURIComponent(sid)}`,
            { credentials: "include" },
          );
          if (!res.ok || cancelled) return;
          const body = (await res.json()) as {
            messages?: HydratedRow[];
          };
          const rows = Array.isArray(body.messages) ? body.messages : [];
          if (!cancelled) setMsgs(logToMsgs(rows));
        } catch {
          if (!cancelled) setMsgs([]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (c.kind === "course") {
      if (!c.hydrateSessionId) return;
      const sid = c.hydrateSessionId;
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(
            `/api/v1/me/chat-threads/${encodeURIComponent(sid)}`,
            { credentials: "include" },
          );
          if (!res.ok || cancelled) return;
          const body = (await res.json()) as {
            messages?: HydratedRow[];
          };
          const rows = Array.isArray(body.messages) ? body.messages : [];
          if (!cancelled) setMsgs(logToMsgs(rows));
        } catch {
          if (!cancelled) setMsgs([]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (c.kind === "personal_kb") {
      if (!c.sessionId) {
        setMsgs([]);
        return;
      }
      const sid = c.sessionId;
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(
            `/api/v1/me/personal-kb/messages/${encodeURIComponent(sid)}`,
            { credentials: "include" },
          );
          if (!res.ok || cancelled) return;
          const body = (await res.json()) as { messages?: HydratedRow[] };
          const rows = Array.isArray(body.messages) ? body.messages : [];
          if (!cancelled) setMsgs(logToMsgs(rows));
        } catch {
          if (!cancelled) setMsgs([]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [historyLoadKey]);

  const addAttachment = useCallback(async (file: File) => {
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      alert(`不支持的文件类型：${file.type || "未知"}`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert("文件大小不能超过 20 MB");
      return;
    }
    const localPreviewUrl = file.type.startsWith("image/")
      ? URL.createObjectURL(file)
      : undefined;

    setAttachmentUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/v1/attachments", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `上传失败 (${res.status})`);
      }
      const data = (await res.json()) as AttachmentRef;
      setPendingAttachments((prev) => [
        ...prev,
        { ...data, localPreviewUrl },
      ]);
    } catch (e) {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
      alert(e instanceof Error ? e.message : "上传失败");
    } finally {
      setAttachmentUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.localPreviewUrl) URL.revokeObjectURL(att.localPreviewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const runChatRequest = useCallback(
    async (
      message: string,
      lessonId: string | undefined,
      attachmentRefs: AttachmentRef[],
      trimHistoryTo?: number,
      currentPageImage?: { presigned_url: string; mime_type: string; name: string },
    ) => {
      const config = cfgRef.current;
      setBusy(true);
      setStreaming("");
      setToolActivity([]);
      streamTimelineRef.current = [];
      setStreamTimeline([]);
      toolSeqRef.current = 0;
      setCitations([]);
      setLastMeta(null);
      setErrorMsg(null);
      setPendingApproval(null);
      pendingApprovalRef.current = null;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const attachmentsPayload = mapAttachmentsForPayload(attachmentRefs);

      try {
        const isQaGlobal = config.kind === "qa_center_global";
        const isPersonalKb = config.kind === "personal_kb";
        const courseId = config.kind === "course" ? config.courseId : "";
        const url = isQaGlobal
          ? "/api/v1/qa-center/chat"
          : isPersonalKb
          ? "/api/v1/me/personal-kb/chat"
          : `/api/v1/courses/${courseId}/chat`;

        const materialId =
          config.kind === "course"
            ? (config.activeMaterialId ?? undefined)
            : config.kind === "personal_kb"
            ? (config.activeMaterialId ?? undefined)
            : undefined;
        const body: Record<string, unknown> = {
          message,
          ...(lessonId ? { lesson_id: lessonId } : {}),
          ...(materialId ? { material_id: materialId } : {}),
          ...(attachmentsPayload.length ? { attachments: attachmentsPayload } : {}),
          ...(trimHistoryTo !== undefined ? { trim_history_to: trimHistoryTo } : {}),
          ...(currentPageImage ? { current_page_image: currentPageImage } : {}),
        };
        if (isQaGlobal && config.sessionId) {
          body.session_id = config.sessionId;
        }
        if (config.kind === "personal_kb" && config.sessionId) {
          body.session_id = config.sessionId;
        }
        if (config.kind === "course" && config.hydrateSessionId) {
          body.session_id = config.hydrateSessionId;
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        });

        if (isQaGlobal) {
          const hdr = res.headers.get("X-Qa-Center-Session-Id");
          if (hdr && config.onResolvedSessionId) {
            config.onResolvedSessionId(hdr);
          }
        }

        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as ApiErrJson;
          throw new Error(formatChatHttpError(res.status, j));
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("无法读取响应流");

        const decoder = new TextDecoder();
        let buffer = "";
        let streamText = "";
        const newCitations: Citation[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const raw = part.slice(6).trim();
            if (!raw) continue;
            try {
              const event = parseB3SseEventJson(raw);
              if (!event) continue;

              if (event.type === "text" && event.content) {
                setIsReflecting(false);
                streamText += event.content;
                setStreaming(streamText);
                // Build interleaved timeline: merge consecutive text chunks
                const tl = streamTimelineRef.current;
                const last = tl.length > 0 ? tl[tl.length - 1] : undefined;
                let nextTl: MessageTimelineItem[];
                if (last?.kind === "text") {
                  nextTl = [...tl.slice(0, -1), { ...last, content: last.content + event.content }];
                } else {
                  nextTl = [...tl, { kind: "text", content: event.content }];
                }
                streamTimelineRef.current = nextTl;
                setStreamTimeline(nextTl);
              } else if (event.type === "tool_call" && event.name) {
                const id =
                  typeof event.tool_call_id === "string" && event.tool_call_id
                    ? event.tool_call_id
                    : `tc-${++toolSeqRef.current}`;
                setToolActivity((prev) => [
                  ...prev,
                  { clientKey: id, name: event.name!, status: "running" },
                ]);
                const nextTl: MessageTimelineItem[] = [
                  ...streamTimelineRef.current,
                  {
                    kind: "tool",
                    clientKey: id,
                    name: event.name!,
                    status: "running",
                    ...(event.input ? { input: event.input as Record<string, unknown> } : {}),
                  },
                ];
                streamTimelineRef.current = nextTl;
                setStreamTimeline(nextTl);
              } else if (event.type === "tool_progress" && event.tool_call_id && event.label) {
                const progressKey = event.tool_call_id;
                const label = event.label;
                const tl = [...streamTimelineRef.current];
                let idx = -1;
                for (let i = tl.length - 1; i >= 0; i--) {
                  const it = tl[i];
                  if (it.kind === "tool" && it.clientKey === progressKey && it.status === "running") {
                    idx = i;
                    break;
                  }
                }
                if (idx !== -1) {
                  tl[idx] = { ...(tl[idx] as Extract<MessageTimelineItem, { kind: "tool" }>), progressLabel: label };
                  streamTimelineRef.current = tl;
                  setStreamTimeline([...tl]);
                }
              } else if (event.type === "tool_result" && event.name) {
                const toolName = event.name;
                const toolCallId = typeof event.tool_call_id === "string" ? event.tool_call_id : undefined;
                const execution = event.execution;
                const toolOutput = event.output;
                const toolMeta = event.meta;

                /** Find last running item matching by clientKey (preferred) then name. */
                function findRunningIdx<T extends { clientKey: string; name: string; status: string }>(
                  arr: T[],
                ): number {
                  if (toolCallId) {
                    for (let i = arr.length - 1; i >= 0; i--) {
                      if (arr[i].status === "running" && arr[i].clientKey === toolCallId) return i;
                    }
                  }
                  for (let i = arr.length - 1; i >= 0; i--) {
                    if (arr[i].status === "running" && arr[i].name === toolName) return i;
                  }
                  return -1;
                }

                setToolActivity((prev) => {
                  const runIdx = findRunningIdx(prev);
                  if (runIdx === -1) return prev;
                  const next = [...prev];
                  next[runIdx] = {
                    ...next[runIdx],
                    status: "done",
                    success: event.success,
                    durationMs: event.duration_ms,
                    ...(execution ? { execution } : {}),
                  };
                  return next;
                });

                const tl = [...streamTimelineRef.current];
                const toolItems = tl
                  .map((it, idx) => (it.kind === "tool" ? { it, idx } : null))
                  .filter((x): x is { it: Extract<MessageTimelineItem, { kind: "tool" }>; idx: number } => x !== null);
                const runIdx = findRunningIdx(toolItems.map((x) => x.it));
                if (runIdx !== -1) {
                  const { idx } = toolItems[runIdx];
                  tl[idx] = {
                    ...(tl[idx] as Extract<MessageTimelineItem, { kind: "tool" }>),
                    status: "done",
                    success: event.success,
                    durationMs: event.duration_ms,
                    ...(execution ? { execution } : {}),
                    ...(toolOutput !== undefined ? { output: toolOutput } : {}),
                    ...(toolMeta ? { meta: toolMeta } : {}),
                  };
                }
                streamTimelineRef.current = tl;
                setStreamTimeline([...tl]);
              } else if (event.type === "citation") {
                newCitations.push({
                  chunk_id: event.chunk_id,
                  material_id: event.material_id,
                  source_label: event.source_label,
                  chunk_text: event.chunk_text,
                  image_urls: event.image_urls,
                });
                setCitations([...newCitations]);
              } else if (event.type === "trace" && event.event === "reflecting") {
                setIsReflecting(true);
              } else if (event.type === "done") {
                setIsReflecting(false);
                const meta: DoneMeta = {
                  type: "done",
                  tokens: event.tokens,
                  exec_time_ms: event.exec_time_ms,
                  error: event.error,
                };
                setLastMeta(meta);
                if (event.error) setErrorMsg(event.error);
              } else if (event.type === "require_approval") {
                const state: PendingApprovalState = {
                  toolCallId: event.tool_call_id,
                  toolName: event.tool_name,
                  argsPreview: event.args_preview,
                  approvalKey: event.approval_key,
                  reason: event.reason,
                  fullCode: event.full_code,
                };
                pendingApprovalRef.current = state;
                setPendingApproval(state);
              } else if (event.type === "approval_resolved") {
                pendingApprovalRef.current = null;
                setPendingApproval(null);
              }
            } catch {
              // Skip malformed SSE events
            }
          }
        }

        if (streamText) {
          // Snapshot the timeline (filter out any lingering "running" items)
          const finalTimeline = streamTimelineRef.current.filter(
            (item): item is MessageTimelineItem =>
              item.kind !== "tool" || item.status === "done",
          );
          const assistantMsg: ChatMessage = {
            clientId: newClientId(),
            role: "assistant",
            text: streamText,
            ...(finalTimeline.length > 0 ? { timeline: finalTimeline } : {}),
            ...(newCitations.length > 0 ? { citations: newCitations } : {}),
          };
          setMsgs((prev) => {
            const next = [...prev, assistantMsg];
            msgsRef.current = next;
            return next;
          });
        }
        setStreaming("");
        setToolActivity([]);
        setIsReflecting(false);
        streamTimelineRef.current = [];
        setStreamTimeline([]);
        setCitations([]);
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          const msg = e instanceof Error ? e.message : "请求失败";
          setErrorMsg(msg);
          const errBubble: ChatMessage = {
            clientId: newClientId(),
            role: "assistant",
            text: `[错误: ${msg}]`,
          };
          setMsgs((prev) => {
            const next = [...prev, errBubble];
            msgsRef.current = next;
            return next;
          });
        }
        setStreaming("");
        setToolActivity([]);
        setIsReflecting(false);
        streamTimelineRef.current = [];
        setStreamTimeline([]);
        setCitations([]);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const sendMessage = useCallback(
    async (text: string, lessonId?: string) => {
      if (busy) return;
      const trimmed = text.trim();
      if (!trimmed && pendingAttachments.length === 0) return;

      const snapshotAttachments = pendingAttachments.slice();
      setPendingAttachments([]);

      const userMsg: ChatMessage = {
        clientId: newClientId(),
        role: "user",
        text: trimmed,
        ...(snapshotAttachments.length ? { attachments: snapshotAttachments } : {}),
      };

      setMsgs((prev) => {
        const next = [...prev, userMsg];
        msgsRef.current = next;
        return next;
      });

      // Silently capture + upload the current page for course chats (5 s timeout, best-effort).
      let currentPageImage: { presigned_url: string; mime_type: string; name: string } | undefined;
      const cfg = cfgRef.current;
      if (cfg.kind === "course" && cfg.captureCurrentPage) {
        try {
          const file = await Promise.race([
            cfg.captureCurrentPage(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (file instanceof File) {
            const form = new FormData();
            form.append("file", file);
            const res = await fetch("/api/v1/attachments", {
              method: "POST",
              credentials: "include",
              body: form,
              signal: AbortSignal.timeout(8000),
            });
            if (res.ok) {
              const data = (await res.json()) as { presigned_url: string; mime_type: string; name: string };
              if (data.presigned_url) {
                currentPageImage = {
                  presigned_url: data.presigned_url,
                  mime_type: data.mime_type || "image/png",
                  name: data.name || file.name,
                };
              }
            }
          }
        } catch {
          // Best-effort: proceed without the page image if capture/upload fails
        }
      }

      await runChatRequest(trimmed, lessonId, snapshotAttachments, undefined, currentPageImage);
    },
    [busy, pendingAttachments, runChatRequest],
  );

  const commitUserEditReplace = useCallback(
    async (replaceFromIndex: number, text: string, lessonId?: string): Promise<boolean> => {
      if (busy) return false;
      const trimmed = text.trim();
      const prev = msgsRef.current;
      const row = prev[replaceFromIndex];
      if (!row || row.role !== "user") return false;
      const hasAtt = (row.attachments?.length ?? 0) > 0;
      if (!trimmed && !hasAtt) return false;

      const attachments = row.attachments ?? [];
      const newUser: ChatMessage = {
        clientId: newClientId(),
        role: "user",
        text: trimmed,
        ...(attachments.length ? { attachments } : {}),
      };

      // ── Branch tracking: save the current tail before overwriting ──
      const turnPosition = replaceFromIndex;
      const oldTailMsgs = prev.slice(turnPosition);
      updateBranchRecords((prevRecords) => {
        const existingIdx = prevRecords.findIndex((r) => r.position === turnPosition);
        if (existingIdx !== -1) {
          // Branch already exists; current state is already stored as one of the entries.
          return prevRecords;
        }
        // Remove stale records at positions >= turnPosition, then add new record.
        const cleaned = prevRecords.filter((r) => r.position < turnPosition);
        return [
          ...cleaned,
          { position: turnPosition, entries: [{ tailMsgs: oldTailMsgs }], activeIdx: 0 },
        ];
      });

      const newMsgs = [...prev.slice(0, replaceFromIndex), newUser];
      msgsRef.current = newMsgs;
      setMsgs(newMsgs);

      await runChatRequest(trimmed, lessonId, attachments, replaceFromIndex);

      // After API response, capture new tail and add as the next branch entry.
      const newTailMsgs = msgsRef.current.slice(turnPosition);
      updateBranchRecords((prevRecords) => {
        const idx = prevRecords.findIndex((r) => r.position === turnPosition);
        if (idx === -1) return prevRecords;
        const record = prevRecords[idx];
        const newEntries = [...record.entries, { tailMsgs: newTailMsgs }];
        const updated: BranchRecord = { ...record, entries: newEntries, activeIdx: newEntries.length - 1 };
        const next = [...prevRecords];
        next[idx] = updated;
        return next;
      });

      return true;
    },
    [busy, runChatRequest, updateBranchRecords],
  );

  const regenerateAssistantAt = useCallback(
    async (assistantIndex: number, lessonId?: string) => {
      if (busy) return;
      const prev = msgsRef.current;
      const userRow = prev[assistantIndex - 1];
      const assistantRow = prev[assistantIndex];
      if (
        !userRow ||
        userRow.role !== "user" ||
        !assistantRow ||
        assistantRow.role !== "assistant"
      ) {
        return;
      }

      // ── Branch tracking: save the current assistant tail before overwriting ──
      // We track at the assistant message position so arrows appear on the assistant bubble.
      const turnPosition = assistantIndex;
      const oldTailMsgs = prev.slice(turnPosition);
      updateBranchRecords((prevRecords) => {
        const existingIdx = prevRecords.findIndex((r) => r.position === turnPosition);
        if (existingIdx !== -1) {
          return prevRecords;
        }
        const cleaned = prevRecords.filter((r) => r.position < turnPosition);
        return [
          ...cleaned,
          { position: turnPosition, entries: [{ tailMsgs: oldTailMsgs }], activeIdx: 0 },
        ];
      });

      const newMsgs = prev.slice(0, assistantIndex);
      msgsRef.current = newMsgs;
      setMsgs(newMsgs);

      await runChatRequest(
        userRow.text,
        lessonId,
        userRow.attachments ?? [],
        assistantIndex - 1,
      );

      // After API response, capture new assistant tail and add as next branch entry.
      const newTailMsgs = msgsRef.current.slice(turnPosition);
      updateBranchRecords((prevRecords) => {
        const idx = prevRecords.findIndex((r) => r.position === turnPosition);
        if (idx === -1) return prevRecords;
        const record = prevRecords[idx];
        const newEntries = [...record.entries, { tailMsgs: newTailMsgs }];
        const updated: BranchRecord = { ...record, entries: newEntries, activeIdx: newEntries.length - 1 };
        const next = [...prevRecords];
        next[idx] = updated;
        return next;
      });
    },
    [busy, runChatRequest, updateBranchRecords],
  );

  /** Navigate between historical branches at the given msg index. */
  const navigateBranch = useCallback(
    (position: number, direction: -1 | 1) => {
      if (busy) return;
      const records = branchRecordsRef.current;
      const recordIdx = records.findIndex((r) => r.position === position);
      if (recordIdx === -1) return;
      const record = records[recordIdx];
      const newIdx = record.activeIdx + direction;
      if (newIdx < 0 || newIdx >= record.entries.length) return;

      const newRecord: BranchRecord = { ...record, activeIdx: newIdx };
      // Clear stale records at positions > this branch point (they belong to a different subtree).
      const cleanedRecords = records
        .filter((r) => r.position <= position)
        .map((r) => (r.position === position ? newRecord : r));
      branchRecordsRef.current = cleanedRecords;
      setBranchRecords(cleanedRecords);

      // Reconstruct msgs from the selected snapshot.
      const targetEntry = record.entries[newIdx];
      const prefix = msgsRef.current.slice(0, position);
      const newMsgs = [...prefix, ...targetEntry.tailMsgs];
      msgsRef.current = newMsgs;
      setMsgs(newMsgs);
    },
    [busy],
  );

  return {
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
  };
}
