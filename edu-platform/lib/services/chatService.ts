import { prisma } from "@/lib/db";
import type { ExecutionPayload } from "@/lib/agent/react-loop";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const px = prisma as any;
import { ApiError } from "@/lib/http/api-error";
import { logger } from "@/lib/logger";

const chatLog = logger.child({ component: "chatService" });
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { getLLMClient, getTitleModel, getVisionModel, getChatModel, getRoleExtraBody, getMemoryModel } from "@/lib/agent/llm-registry";
import { runWithUserLlm } from "@/lib/agent/user-llm-store";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "@/lib/agent/tracing/langfuse-tracer";
import { createReActStream } from "@/lib/agent/react-loop";
import { sessionStore } from "@/lib/agent/session-store";
import type { Message } from "@/lib/agent/types";
import {
  getMemoryCoordinator,
  getSkillsLoader,
  buildAgentConfig,
  ContextManager,
} from "@/lib/agent/setup";
import { promptBuilder } from "@/lib/agent/prompt-builder";
import { memoryStore } from "@/lib/agent/memory/memory-store";
import { loadEnabledStyles } from "@/lib/services/agentStyleService";
import { toolRegistry } from "@/lib/agent/tools/index";

type ToolCallRecord = {
  name: string;
  status: "done";
  success?: boolean;
  durationMs?: number;
  execution?: ExecutionPayload;
};

type PersistedCitation = {
  chunk_id?: string;
  material_id?: string;
  source_label?: string;
  chunk_text?: string;
  image_urls?: Array<{ page_idx: number; url: string }>;
};

export type B3SseEvent =
  | { type: "text"; content: string }
  | {
      type: "citation";
      chunk_id?: string;
      material_id?: string;
      source_label?: string;
      chunk_text?: string;
      image_urls?: Array<{ page_idx: number; url: string }>;
    }
  | {
      type: "tool_call";
      name: string;
      tool_call_id?: string;
    }
  | {
      type: "tool_result";
      name: string;
      success?: boolean;
      duration_ms?: number;
      output?: string;
      execution?: ExecutionPayload;
    }
  | {
      type: "done";
      tokens?: number | null;
      exec_time_ms?: number | null;
      error?: string;
    }
  | {
      type: "trace";
      trace_id?: string;
      event?: string;
      turn_id?: string;
      ts?: string;
      payload?: Record<string, unknown>;
    }
  | {
      type: "require_approval";
      tool_call_id: string;
      tool_name: string;
      args_preview: Record<string, unknown>;
      approval_key: string;
      reason: string;
      full_code?: string;
    }
  | { type: "approval_resolved"; tool_call_id: string; approved: boolean };

const enc = new TextEncoder();

function sseDataLine(obj: B3SseEvent): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function parseSseDataPayload(block: string): string | null {
  const lines = block.split("\n").map((l) => l.replace(/\r$/, ""));
  const dataLines = lines.filter((l) => l.startsWith("data:"));
  if (dataLines.length === 0) return null;
  return dataLines.map((l) => l.replace(/^data:\s?/, "")).join("\n");
}

function citationsFromB3(b3: Record<string, unknown>): B3SseEvent[] {
  const chunks = Array.isArray(b3.hit_chunks) ? (b3.hit_chunks as string[]) : [];
  const chunkTexts = Array.isArray(b3.hit_chunk_texts) ? (b3.hit_chunk_texts as string[]) : [];
  const mats = Array.isArray(b3.hit_materials) ? (b3.hit_materials as string[]) : [];
  const srcs = Array.isArray(b3.hit_sources) ? (b3.hit_sources as string[]) : [];
  const n = Math.max(chunks.length, mats.length, srcs.length);
  const out: B3SseEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: "citation",
      chunk_id: chunks[i] || undefined,
      material_id: mats[i] || undefined,
      source_label: srcs[i] || undefined,
      chunk_text: chunkTexts[i] || undefined,
    });
  }
  return out;
}

function toolCallEventFromAgentFrame(
  frame: Record<string, unknown>,
): Extract<B3SseEvent, { type: "tool_call" }> | null {
  const eduMeta = frame.edu_meta as Record<string, unknown> | undefined;
  if (eduMeta?.content_type !== "tool_call") return null;
  const choices = frame.choices as Record<string, unknown>[] | undefined;
  const ch0 = choices?.[0] as Record<string, unknown> | undefined;
  const delta = ch0?.delta as Record<string, unknown> | undefined;
  const toolCalls = delta?.tool_calls as unknown[] | undefined;
  const first = toolCalls?.[0] as Record<string, unknown> | undefined;
  const fn = first?.function as Record<string, unknown> | undefined;
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  if (!name) return null;
  const tool_call_id = typeof first?.id === "string" ? first.id : undefined;
  return { type: "tool_call", name, tool_call_id };
}

function toolResultEventFromAgentFrame(
  frame: Record<string, unknown>,
): Extract<B3SseEvent, { type: "tool_result" }> | null {
  const eduMeta = frame.edu_meta as Record<string, unknown> | undefined;
  if (eduMeta?.content_type !== "tool_result") return null;
  const b3 = eduMeta.b3 as Record<string, unknown> | undefined;
  if (!b3 || typeof b3 !== "object") return null;
  const name = typeof b3.tool_name === "string" ? b3.tool_name.trim() : "";
  if (!name) return null;
  const success = typeof b3.success === "boolean" ? b3.success : undefined;
  const ds = b3.duration_s;
  const duration_ms =
    typeof ds === "number" && Number.isFinite(ds) ? Math.round(ds * 1000) : undefined;
  return { type: "tool_result", name, success, duration_ms };
}

function traceEventFromAgentFrame(
  frame: Record<string, unknown>,
): Extract<B3SseEvent, { type: "trace" }> | null {
  const eduMeta = frame.edu_meta as Record<string, unknown> | undefined;
  if (eduMeta?.content_type !== "meta") return null;
  const meta = eduMeta.b3 as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") return null;
  const event = typeof meta.trace_event === "string" ? meta.trace_event : undefined;
  if (!event) return null;
  const trace_id = typeof meta.trace_id === "string" ? meta.trace_id : undefined;
  const turn_id = typeof meta.turn_id === "string" ? meta.turn_id : undefined;
  const ts = typeof meta.ts === "string" ? meta.ts : undefined;
  return {
    type: "trace",
    trace_id,
    event,
    turn_id,
    ts,
    payload: meta,
  };
}

export async function getOrCreateCourseChatSession(
  courseId: string,
  platformStudentId: string,
): Promise<string> {
  const row = await prisma.courseChatSession.findFirst({
    where: { courseId, studentId: platformStudentId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (row) return row.agentSessionId;
  const agentSessionId = randomUUID();
  try {
    await prisma.courseChatSession.create({
      data: { courseId, studentId: platformStudentId, agentSessionId },
    });
  } catch {
    // concurrent create — fetch again
    const again = await prisma.courseChatSession.findFirst({
      where: { courseId, studentId: platformStudentId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (again) return again.agentSessionId;
    throw new ApiError(500, "INTERNAL_ERROR", "Failed to persist chat session");
  }
  return agentSessionId;
}

export async function createNewCourseChatSession(
  courseId: string,
  platformStudentId: string,
): Promise<string> {
  const agentSessionId = randomUUID();
  await prisma.courseChatSession.create({
    data: { courseId, studentId: platformStudentId, agentSessionId },
  });
  return agentSessionId;
}

type PersistArgs = {
  courseId: string | null;
  platformStudentId: string;
  sessionId: string;
  question: string;
  answer: string;
  persist: boolean;
  b3?: Record<string, unknown>;
  toolCalls?: ToolCallRecord[];
  citations?: PersistedCitation[];
};

async function maybePersistQaLog(a: PersistArgs): Promise<void> {
  if (!a.persist || !a.b3) return;
  const b3 = a.b3;
  const exec = Number(b3.execution_time_ms);
  const modelUsed = typeof b3.model_used === "string" ? b3.model_used : "unknown";
  await prisma.qaLog.create({
    data: {
      courseId: a.courseId,
      studentId: a.platformStudentId,
      sessionId: a.sessionId,
      question: a.question,
      questionTokens:
        typeof b3.prompt_tokens === "number" ? b3.prompt_tokens : null,
      answer: a.answer,
      answerTokens:
        typeof b3.completion_tokens === "number" ? b3.completion_tokens : null,
      totalTokens:
        typeof b3.total_tokens === "number" ? b3.total_tokens : null,
      executionTimeMs: Number.isFinite(exec) ? exec : 0,
      modelUsed: modelUsed.slice(0, 100),
      hitChunks: Array.isArray(b3.hit_chunks) ? (b3.hit_chunks as string[]) : [],
      hitMaterials: Array.isArray(b3.hit_materials)
        ? (b3.hit_materials as string[])
        : [],
      hitSources: Array.isArray(b3.hit_sources) ? (b3.hit_sources as string[]) : [],
      toolCalls: a.toolCalls ?? [],
      citations: a.citations ?? [],
    } as Parameters<typeof prisma.qaLog.create>[0]["data"],
  });
}

/**
 * Transform Agent OpenAI-style SSE into B3 ``text`` / ``citation`` / ``done`` events.
 * After the stream completes, optionally inserts ``QaLog``.
 */
export function createB3SseTransformFromAgent(
  persistCtx: PersistArgs,
): TransformStream<Uint8Array, Uint8Array> {
  let buf = "";
  let fullAnswer = "";
  let lastB3: Record<string, unknown> | undefined;
  let sawDoneMarker = false;
  let streamError: string | undefined;
  const collectedToolCalls: ToolCallRecord[] = [];
  // pending: tool_call events waiting to be matched with a tool_result
  const pendingToolCalls = new Map<string, ToolCallRecord>();

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += new TextDecoder().decode(chunk, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx === -1) break;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const raw = parseSseDataPayload(block);
        if (raw === null) continue;
        if (raw === "[DONE]") {
          sawDoneMarker = true;
          const citationEvents = citationsFromB3(lastB3 ?? {});
          for (const c of citationEvents) {
            controller.enqueue(sseDataLine(c));
          }
          const tokens =
            typeof lastB3?.total_tokens === "number"
              ? lastB3.total_tokens
              : null;
          const exec =
            typeof lastB3?.execution_time_ms === "number"
              ? lastB3.execution_time_ms
              : null;
          controller.enqueue(
            sseDataLine({
              type: "done",
              tokens,
              exec_time_ms: exec,
              error: streamError,
            }),
          );
          continue;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          streamError = streamError ?? "INVALID_AGENT_SSE_JSON";
          continue;
        }
        if (frame.error && !Array.isArray(frame.choices)) {
          streamError =
            typeof frame.error === "string"
              ? frame.error
              : JSON.stringify(frame.error);
          continue;
        }
        const eduMeta = frame.edu_meta as Record<string, unknown> | undefined;
        const choices = frame.choices as Record<string, unknown>[] | undefined;
        const ch0 = choices?.[0] as Record<string, unknown> | undefined;
        const delta = ch0?.delta as Record<string, unknown> | undefined;
        const content =
          delta && typeof delta.content === "string" ? delta.content : "";
        // Skip the final summary frame (is_final=true, content_type="text"):
        // agent.py emits a full-text summary frame after streaming all delta
        // tokens, which would cause the response to appear twice.
        const isFinalTextFrame =
          eduMeta?.is_final === true && eduMeta?.content_type === "text";
        if (content && eduMeta?.content_type === "text" && !isFinalTextFrame) {
          fullAnswer += content;
          controller.enqueue(sseDataLine({ type: "text", content }));
        }
        const tcEv = toolCallEventFromAgentFrame(frame);
        if (tcEv) {
          controller.enqueue(sseDataLine(tcEv));
          const key = tcEv.tool_call_id ?? tcEv.name;
          pendingToolCalls.set(key, { name: tcEv.name, status: "done" });
        }
        const trEv = toolResultEventFromAgentFrame(frame);
        if (trEv) {
          controller.enqueue(sseDataLine(trEv));
          // match by name (tool_call_id may differ between call and result)
          let matchKey: string | undefined;
          for (const [k, v] of pendingToolCalls) {
            if (v.name === trEv.name) { matchKey = k; break; }
          }
          if (matchKey !== undefined) {
            const rec = pendingToolCalls.get(matchKey)!;
            collectedToolCalls.push({ ...rec, success: trEv.success, durationMs: trEv.duration_ms });
            pendingToolCalls.delete(matchKey);
          } else {
            collectedToolCalls.push({ name: trEv.name, status: "done", success: trEv.success, durationMs: trEv.duration_ms });
          }
        }
        const traceEv = traceEventFromAgentFrame(frame);
        if (traceEv) controller.enqueue(sseDataLine(traceEv));
        const b3 = eduMeta?.b3 as Record<string, unknown> | undefined;
        if (b3 && typeof b3 === "object") {
          lastB3 = { ...lastB3, ...b3 };
        }
      }
    },
    async flush(controller) {
      if (!sawDoneMarker) {
        controller.enqueue(
          sseDataLine({
            type: "done",
            tokens: null,
            exec_time_ms: null,
            error: streamError ?? "STREAM_INCOMPLETE",
          }),
        );
        return;
      }
      if (!streamError) {
        const persistedCitations: PersistedCitation[] = citationsFromB3(lastB3 ?? {}).map(
          (ev) => ({
            chunk_id: (ev as { chunk_id?: string }).chunk_id,
            material_id: (ev as { material_id?: string }).material_id,
            source_label: (ev as { source_label?: string }).source_label,
            chunk_text: (ev as { chunk_text?: string }).chunk_text,
          }),
        );
        // flush any unmatched tool_calls (no result received)
        for (const rec of pendingToolCalls.values()) {
          collectedToolCalls.push(rec);
        }
        await maybePersistQaLog({
          ...persistCtx,
          answer: fullAnswer,
          b3: lastB3,
          toolCalls: collectedToolCalls,
          citations: persistedCitations,
        });
      }
    },
  });
}

export type AttachmentParam = {
  id: string;
  key: string;
  presigned_url: string;
  mime_type: string;
  name: string;
};

// ---- B3 persist transform (for TS ReAct loop output) -----------------------

type PersistTransformOpts = {
  courseId: string | null;
  platformStudentId: string;
  sessionId: string;
  question: string;
  persist: boolean;
  /** Langfuse trace ID — stored in QaLog.metadata for cross-system correlation. */
  traceId?: string;
  /** Snapshot of session history at request-start time (after any trimming). Used by flush() to avoid re-reading Redis. */
  baseHistory: Message[];
};

function createB3PersistTransform(
  opts: PersistTransformOpts,
): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  let fullAnswer = "";
  const collectedToolCalls: ToolCallRecord[] = [];
  const collectedCitations: PersistedCitation[] = [];
  let totalTokens: number | null = null;
  let execTimeMs: number | null = null;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // pass-through unchanged
      buf += dec.decode(chunk, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx === -1) break;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice("data: ".length);
        let ev: { type: string; [k: string]: unknown };
        try {
          ev = JSON.parse(jsonStr) as typeof ev;
        } catch {
          continue;
        }
        if (ev.type === "text") {
          fullAnswer += (ev.content as string) ?? "";
        } else if (ev.type === "tool_result") {
          collectedToolCalls.push({
            name: ev.name as string,
            status: "done",
            success: ev.success as boolean | undefined,
            durationMs: ev.duration_ms as number | undefined,
            execution: ev.execution as ExecutionPayload | undefined,
          });
        } else if (ev.type === "citation") {
          collectedCitations.push({
            chunk_id: ev.chunk_id as string | undefined,
            material_id: ev.material_id as string | undefined,
            source_label: ev.source_label as string | undefined,
            chunk_text: ev.chunk_text as string | undefined,
            image_urls: ev.image_urls as Array<{ page_idx: number; url: string }> | undefined,
          });
        } else if (ev.type === "done") {
          totalTokens = typeof ev.tokens === "number" ? ev.tokens : null;
          execTimeMs = typeof ev.exec_time_ms === "number" ? ev.exec_time_ms : null;
        }
      }
    },
    async flush() {
      if (opts.persist) {
        try {
          const model = getChatModel().slice(0, 100);
          await prisma.qaLog.create({
            data: {
              courseId: opts.courseId,
              studentId: opts.platformStudentId,
              sessionId: opts.sessionId,
              question: opts.question,
              questionTokens: null,
              answer: fullAnswer,
              answerTokens: null,
              totalTokens,
              executionTimeMs: execTimeMs ?? 0,
              modelUsed: model,
              hitChunks: [],
              hitMaterials: [],
              hitSources: [],
              toolCalls: collectedToolCalls,
              citations: collectedCitations,
              metadata: opts.traceId ? { langfuseTraceId: opts.traceId } : undefined,
            } as Parameters<typeof prisma.qaLog.create>[0]["data"],
          });
          // Fire-and-forget: set session title on the first message
          void maybeAutoTitleSession(
            opts.sessionId,
            opts.platformStudentId,
            opts.question,
          );
        } catch (err) {
          chatLog.error({ err }, "QaLog persist failed");
        }
      }
      // Update session history in Redis using the snapshot captured at request-start.
      // This avoids a race condition where a concurrent request could corrupt the history
      // if we re-read Redis here, and ensures trim_history_to is respected on write-back.
      try {
        const updated = [
          ...opts.baseHistory,
          { role: "user" as const, content: opts.question },
          { role: "assistant" as const, content: fullAnswer },
        ];
        await sessionStore.set(opts.sessionId, updated);
      } catch (err) {
        chatLog.error({ err }, "Session store update failed");
      }
    },
  });
}

// ---- Vision pre-processing ------------------------------------------------

function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  if (!h.includes(".")) return true; // e.g. docker internal host: "minio"
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

function normalizeVisionUrl(raw: string): string {
  // Keep query string intact while escaping non-ASCII chars (common in filenames).
  return encodeURI(raw.trim());
}

async function toInlineDataUrl(url: string, fallbackMime: string): Promise<string | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") ?? fallbackMime)
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

async function buildVisionImageUrl(att: AttachmentParam): Promise<string | null> {
  const raw = att.presigned_url?.trim();
  if (!raw) return null;

  let normalized: string;
  try {
    normalized = normalizeVisionUrl(raw);
    const parsed = new URL(normalized);
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isHttp) return null;

    // Many hosted vision providers reject/无法访问私网地址；改成 data URL 更稳。
    if (isPrivateOrLocalHostname(parsed.hostname)) {
      const inline = await toInlineDataUrl(normalized, att.mime_type || "image/png");
      if (inline) return inline;
      return null; // Cannot pass private/local URL to external vision model
    }
  } catch {
    return null;
  }

  return normalized;
}

/**
 * If there are image attachments, call the vision model (e.g. qwen3.6-plus) first
 * to generate a text description, then prepend it to the user message.
 * Falls back to the original message on any error.
 */
async function describeImageAttachments(
  attachments: AttachmentParam[] | undefined,
  userMessage: string,
): Promise<string> {
  const imageAtts = attachments?.filter((a) => a.mime_type.startsWith("image/")) ?? [];
  if (imageAtts.length === 0) return userMessage;

  try {
    const client = getLLMClient("vision");
    const model = getVisionModel();

    const imageUrls = (
      await Promise.all(imageAtts.map((a) => buildVisionImageUrl(a)))
    ).filter((u): u is string => !!u);
    if (imageUrls.length === 0) return userMessage;

    const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: "text", text: "请详细描述以下图片的内容，包括文字、图表、示意图、公式等所有可见信息：" },
      ...imageUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ];

    const trace = createStandaloneTrace({
      name: "chat.describe_images",
      metadata: { model, imageCount: imageUrls.length },
    });
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: contentParts }],
      max_tokens: 1000,
    });

    const description = resp.choices[0]?.message?.content?.trim();
    recordGeneration(trace, {
      name: "describe_images_llm",
      model,
      input: contentParts,
      output: description,
      usage: {
        promptTokens: resp.usage?.prompt_tokens,
        completionTokens: resp.usage?.completion_tokens,
        totalTokens: resp.usage?.total_tokens,
      },
    });
    void flushLangfuse();
    if (!description) return userMessage;

    return `[图片内容理解]\n${description}\n\n${userMessage}`;
  } catch (err) {
    chatLog.error({ err }, "Vision pre-process failed");
    return userMessage;
  }
}

/**
 * Fetch text/code attachment contents via presigned URLs and inject them into
 * the user message as fenced code blocks, so the agent can read them directly.
 * Silently skips any attachment that fails to fetch.
 */
async function hydrateTextAttachments(
  attachments: AttachmentParam[] | undefined,
  userMessage: string,
): Promise<string> {
  const TEXT_MIMES = new Set([
    "text/plain",
    "text/markdown",
    "text/x-python",
    "application/x-python",
    "application/x-python-code",
    "text/x-javascript",
    "application/javascript",
    "text/javascript",
    "text/typescript",
    "text/x-typescript",
  ]);
  const TEXT_ATTACH_MAX_CHARS = 8000;

  const textAtts = attachments?.filter(
    (a) => !a.mime_type.startsWith("image/") && TEXT_MIMES.has(a.mime_type),
  ) ?? [];
  if (textAtts.length === 0) return userMessage;

  const injections: string[] = [];
  for (const att of textAtts) {
    try {
      const resp = await fetch(att.presigned_url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) continue;
      let content = await resp.text();
      let truncated = false;
      if (content.length > TEXT_ATTACH_MAX_CHARS) {
        content = content.slice(0, TEXT_ATTACH_MAX_CHARS);
        truncated = true;
      }
      injections.push(
        `[附件：${att.name}]\n\`\`\`\n${content}\n\`\`\`${truncated ? "\n（内容已截断，如需完整内容请使用 read_attachment 工具）" : ""}`,
      );
    } catch {
      // skip silently — attachment may be unavailable or timed out
    }
  }

  if (injections.length === 0) return userMessage;
  return `${userMessage}\n\n${injections.join("\n\n")}`;
}

// ---- Auto-title for new sessions -----------------------------------------

async function generateChatTitle(question: string): Promise<string | null> {
  try {
    const client = getLLMClient("title");
    const model = getTitleModel();
    const titleExtraBody = getRoleExtraBody("title");
    const trace = createStandaloneTrace({ name: "chat.generate_title", metadata: { model } });
    const resp = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: `根据下面这条用户消息，生成一个简洁的对话标题（不超过20字，不要加引号，不要加标点在开头结尾）：\n\n${question.slice(0, 500)}`,
        },
      ],
      max_tokens: 50,
      temperature: 0.3,
      stream: false,
      // Disable DeepSeek thinking mode
      ...titleExtraBody,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
    const title = resp.choices[0]?.message?.content?.trim();
    recordGeneration(trace, {
      name: "generate_title_llm",
      model,
      input: question.slice(0, 500),
      output: title,
      usage: {
        promptTokens: resp.usage?.prompt_tokens,
        completionTokens: resp.usage?.completion_tokens,
        totalTokens: resp.usage?.total_tokens,
      },
    });
    void flushLangfuse();
    return title ?? null;
  } catch {
    return null;
  }
}

async function maybeAutoTitleSession(
  sessionId: string,
  studentId: string,
  question: string,
): Promise<void> {
  try {
    const count = await prisma.qaLog.count({
      where: { sessionId, studentId, deletedAt: null, answer: { not: null } },
    });
    if (count !== 1) return; // Only title the first completed message
    const existing = await px.chatThreadTitleOverride.findFirst({
      where: { studentId, sessionId },
    });
    if (existing) return;
    const qcs = await px.qaCenterSession.findFirst({
      where: { agentSessionId: sessionId, studentId, deletedAt: null },
    });
    if (qcs?.title) return;
    const title = await generateChatTitle(question);
    if (!title) return;
    // For QaCenterSession: update title directly; for course sessions: upsert override.
    if (qcs) {
      await px.qaCenterSession.update({
        where: { id: qcs.id },
        data: { title },
      });
    } else {
      await px.chatThreadTitleOverride.upsert({
        where: { studentId_sessionId: { studentId, sessionId } },
        create: { studentId, sessionId, title },
        update: { title },
      });
    }
  } catch (err) {
    console.error("[chatService] auto-title failed:", err);
  }
}

// ---- Course chat -----------------------------------------------------------

export type CourseChatParams = {
  courseId: string;
  platformStudentId: string;
  userId: string;
  message: string;
  accessibleCourseIds: string[];
  lessonId?: string | null;
  materialId?: string | null;
  attachments?: AttachmentParam[];
  traceId?: string | null;
  debugTrace?: boolean;
  /** When set, truncate session history to this many messages before processing (used for regenerate/edit). */
  trimHistoryTo?: number;
  /** When set, route message to this specific session instead of the default get-or-create session. */
  sessionId?: string | null;
  /** When true, bypass pedagogical system prompt and skills for evaluation/benchmark use. */
  evalMode?: boolean;
  /**
   * Implicitly captured page screenshot uploaded silently by the frontend on message send.
   * Not shown in the chat UI; the LLM accesses it via the view_current_material_page tool.
   */
  currentPageImage?: { presigned_url: string; mime_type: string; name: string } | null;
};

/**
 * Returns a ``Response`` with ``text/event-stream`` body (B3 SSE), or throws ``ApiError``.
 */
export async function courseChatSseResponse(
  p: CourseChatParams,
): Promise<Response> {
  return runWithUserLlm(p.platformStudentId, async () => {
  let sessionId: string;
  if (p.sessionId) {
    const row = await prisma.courseChatSession.findFirst({
      where: { agentSessionId: p.sessionId, studentId: p.platformStudentId, courseId: p.courseId, deletedAt: null },
    });
    if (!row) throw new ApiError(403, "FORBIDDEN", "Invalid session_id");
    sessionId = p.sessionId;
  } else {
    sessionId = await getOrCreateCourseChatSession(p.courseId, p.platformStudentId);
  }

  // Load session history + memory
  const [history, profile] = await Promise.all([
    sessionStore.get(sessionId).catch(() => []),
    memoryStore.loadProfile(p.platformStudentId).catch(() => null),
  ]);

  // Pre-fetch material context when user is viewing a specific material
  let materialContext: import("@/lib/agent/types").MaterialContext | null = null;
  if (p.materialId) {
    const mat = await prisma.material.findUnique({
      where: { id: p.materialId },
      select: { id: true, originalFilename: true, fileType: true, videoSummary: true, documentSummary: true },
    });
    if (mat) {
      materialContext = {
        materialId: mat.id,
        filename: mat.originalFilename,
        fileType: mat.fileType,
        videoSummary: mat.videoSummary ?? null,
        documentSummary: mat.documentSummary ?? null,
      };
    }
  }

  // Apply trim: when regenerating or editing, discard history beyond the branch point.
  const effectiveHistory: Message[] =
    p.trimHistoryTo !== undefined ? history.slice(0, p.trimHistoryTo) : history;

  // Summarise older turns with LLM when history is too long; falls back to sliding-window on error.
  const ctxMgr = new ContextManager(
    parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS ?? "120000", 10),
  );
  const { messages: summarizedHistory } = await ctxMgr
    .compressWithSummary(effectiveHistory, getLLMClient("memory"), getMemoryModel())
    .catch(() => ({ messages: effectiveHistory, didSummarize: false }));

  const coordinator = getMemoryCoordinator();
  const memoryBlock = await coordinator
    .buildRetrievedMemoryBlock(p.platformStudentId, p.message)
    .catch(() => "");

  const skills = await (async () => {
    if (p.evalMode) return []; // No pedagogical skills in eval mode
    const fileSkills = getSkillsLoader()
      .load()
      .map((s) => (s.name === "course_qa" ? { ...s, alwaysInject: true } : s));
    const dbStyles = await loadEnabledStyles();
    const dbNames = new Set(dbStyles.map((s) => s.name));
    return [...fileSkills.filter((s) => !dbNames.has(s.name)), ...dbStyles];
  })();
  const userMessage = await hydrateTextAttachments(
    p.attachments,
    await describeImageAttachments(p.attachments, p.message),
  );
  const config = buildAgentConfig(
    p.attachments?.map((a) => ({
      id: a.id,
      presigned_url: a.presigned_url,
      mime_type: a.mime_type,
      name: a.name,
    })),
    p.evalMode,
  );

  const traceId = p.traceId ?? randomUUID();
  const stream = createReActStream({
    userMessage,
    config,
    toolRegistry,
    ctx: {
      userId: p.platformStudentId,
      sessionId,
      accessibleCourseIds: p.accessibleCourseIds,
      courseId: p.courseId,
      lessonId: p.lessonId ?? null,
      materialId: p.materialId ?? null,
      materialContext,
      currentPageImage: p.currentPageImage ?? null,
      traceId,
      debugTrace: p.debugTrace ?? false,
      evalMode: p.evalMode ?? false,
    },
    coordinator,
    promptBuilder,
    skills,
    profile,
    memoryBlock,
    history: summarizedHistory,
    allowedTools: p.evalMode ? ["knowledge_query"] : undefined,
    evalMode: p.evalMode,
  });

  const out = stream.pipeThrough(
    createB3PersistTransform({
      courseId: p.courseId,
      platformStudentId: p.platformStudentId,
      sessionId,
      question: p.message,
      persist: true,
      traceId,
      baseHistory: summarizedHistory,
    }),
  );

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
  }); // end runWithUserLlm
}

export type QaCenterChatParams = {
  platformStudentId: string;
  userId: string;
  message: string;
  accessibleCourseIds: string[];
  sessionId?: string | null;
  attachments?: AttachmentParam[];
  traceId?: string | null;
  debugTrace?: boolean;
  /** When set, truncate session history to this many messages before processing (used for regenerate/edit). */
  trimHistoryTo?: number;
};

export type PersonalKbChatParams = {
  userId: string;
  message: string;
  sessionId: string;
  materialId?: string | null;
  attachments?: AttachmentParam[];
  traceId?: string | null;
  debugTrace?: boolean;
  trimHistoryTo?: number;
};

async function getOrCreateQaCenterAgentSession(
  platformStudentId: string,
  existingSessionId?: string | null,
): Promise<string> {
  const sid = existingSessionId?.trim();
  if (sid) {
    const row = await px.qaCenterSession.findFirst({
      where: {
        agentSessionId: sid,
        studentId: platformStudentId,
        deletedAt: null,
      },
    });
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", "问答会话不存在或已删除");
    }
    return row.agentSessionId;
  }
  const agentSessionId = randomUUID();
  try {
    await px.qaCenterSession.create({
      data: {
        studentId: platformStudentId,
        agentSessionId,
      },
    });
  } catch {
    const again = await px.qaCenterSession.findFirst({
      where: {
        agentSessionId,
        studentId: platformStudentId,
        deletedAt: null,
      },
    });
    if (again) return again.agentSessionId;
    throw new ApiError(500, "INTERNAL_ERROR", "Failed to persist QA center session");
  }
  return agentSessionId;
}

/** QA center: no course header; RAG uses ``enrolled_courses`` in EduAgent. */
export async function qaCenterChatSseResponse(
  p: QaCenterChatParams,
): Promise<Response> {
  return runWithUserLlm(p.platformStudentId, async () => {
  const sessionId = await getOrCreateQaCenterAgentSession(
    p.platformStudentId,
    p.sessionId,
  );

  const [history, profile] = await Promise.all([
    sessionStore.get(sessionId).catch(() => []),
    memoryStore.loadProfile(p.platformStudentId).catch(() => null),
  ]);

  // Apply trim: when regenerating or editing, discard history beyond the branch point.
  const effectiveHistory: Message[] =
    p.trimHistoryTo !== undefined ? history.slice(0, p.trimHistoryTo) : history;

  // Summarise older turns with LLM when history is too long; falls back to sliding-window on error.
  const ctxMgr = new ContextManager(
    parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS ?? "120000", 10),
  );
  const { messages: summarizedHistory } = await ctxMgr
    .compressWithSummary(effectiveHistory, getLLMClient("memory"), getMemoryModel())
    .catch(() => ({ messages: effectiveHistory, didSummarize: false }));

  const coordinator = getMemoryCoordinator();
  const memoryBlock = await coordinator
    .buildRetrievedMemoryBlock(p.platformStudentId, p.message)
    .catch(() => "");

  const skills = await (async () => {
    const fileSkills = getSkillsLoader()
      .load()
      .map((s) => (s.name === "course_qa" ? { ...s, alwaysInject: true } : s));
    const dbStyles = await loadEnabledStyles();
    const dbNames = new Set(dbStyles.map((s) => s.name));
    return [...fileSkills.filter((s) => !dbNames.has(s.name)), ...dbStyles];
  })();
  const userMessage = await hydrateTextAttachments(
    p.attachments,
    await describeImageAttachments(p.attachments, p.message),
  );
  const config = buildAgentConfig(
    p.attachments?.map((a) => ({
      id: a.id,
      presigned_url: a.presigned_url,
      mime_type: a.mime_type,
      name: a.name,
    })),
  );

  const stream = createReActStream({
    userMessage,
    config,
    toolRegistry,
    ctx: {
      userId: p.platformStudentId,
      sessionId,
      accessibleCourseIds: p.accessibleCourseIds,
      courseId: null,
      lessonId: null,
      traceId: p.traceId ?? randomUUID(),
      debugTrace: p.debugTrace ?? false,
    },
    coordinator,
    promptBuilder,
    skills,
    profile,
    memoryBlock,
    history: summarizedHistory,
  });

  const out = stream.pipeThrough(
    createB3PersistTransform({
      courseId: null,
      platformStudentId: p.platformStudentId,
      sessionId,
      question: p.message,
      persist: true,
      traceId: p.traceId ?? undefined,
      baseHistory: summarizedHistory,
    }),
  );

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Qa-Center-Session-Id": sessionId,
    },
  });
  }); // end runWithUserLlm
}

/** Personal knowledge base chat: RAG queries only the user's personal uploaded materials. */
export async function personalKbChatSseResponse(
  p: PersonalKbChatParams,
): Promise<Response> {
  return runWithUserLlm(p.userId, async () => {
  const [history, profile] = await Promise.all([
    sessionStore.get(p.sessionId).catch(() => []),
    memoryStore.loadProfile(p.userId).catch(() => null),
  ]);

  const effectiveHistory: Message[] =
    p.trimHistoryTo !== undefined ? history.slice(0, p.trimHistoryTo) : history;

  // Summarise older turns with LLM when history is too long; falls back to sliding-window on error.
  const ctxMgr = new ContextManager(
    parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS ?? "120000", 10),
  );
  const { messages: summarizedHistory } = await ctxMgr
    .compressWithSummary(effectiveHistory, getLLMClient("memory"), getMemoryModel())
    .catch(() => ({ messages: effectiveHistory, didSummarize: false }));

  // Pre-fetch personal material context when user is viewing a specific material
  let materialContext: import("@/lib/agent/types").MaterialContext | null = null;
  if (p.materialId) {
    const mat = await prisma.personalMaterial.findUnique({
      where: { id: p.materialId },
      select: { id: true, originalFilename: true, fileType: true, videoSummary: true, documentSummary: true },
    });
    if (mat) {
      materialContext = {
        materialId: mat.id,
        filename: mat.originalFilename,
        fileType: mat.fileType,
        videoSummary: mat.videoSummary ?? null,
        documentSummary: mat.documentSummary ?? null,
      };
    }
  }

  const coordinator = getMemoryCoordinator();
  const memoryBlock = await coordinator
    .buildRetrievedMemoryBlock(p.userId, p.message)
    .catch(() => "");

  // Inject personal_kb skill; keep rag_usage skill if present; always include DB styles
  const skills = await (async () => {
    const fileSkills = getSkillsLoader()
      .load()
      .filter((s) => ["rag_usage", "concept_clarification", "scaffolding"].includes(s.name));
    const dbStyles = await loadEnabledStyles();
    const dbNames = new Set(dbStyles.map((s) => s.name));
    return [...fileSkills.filter((s) => !dbNames.has(s.name)), ...dbStyles];
  })();

  const userMessage = await hydrateTextAttachments(
    p.attachments,
    await describeImageAttachments(p.attachments, p.message),
  );
  const config = buildAgentConfig(
    p.attachments?.map((a) => ({
      id: a.id,
      presigned_url: a.presigned_url,
      mime_type: a.mime_type,
      name: a.name,
    })),
  );

  const stream = createReActStream({
    userMessage,
    config,
    toolRegistry,
    ctx: {
      userId: p.userId,
      sessionId: p.sessionId,
      accessibleCourseIds: [],
      courseId: null,
      lessonId: null,
      materialId: p.materialId ?? null,
      materialContext,
      traceId: p.traceId ?? randomUUID(),
      debugTrace: p.debugTrace ?? false,
      personalKbUserId: p.userId,
    },
    coordinator,
    promptBuilder,
    skills,
    profile,
    memoryBlock,
    history: summarizedHistory,
  });

  const out = stream.pipeThrough(
    createB3PersistTransform({
      courseId: null,
      platformStudentId: p.userId,
      sessionId: p.sessionId,
      question: p.message,
      persist: false,
      traceId: p.traceId ?? undefined,
      baseHistory: summarizedHistory,
    }),
  );

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
  }); // end runWithUserLlm
}

