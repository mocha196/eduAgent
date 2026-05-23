/**
 * ReAct Loop — TS Agent core inference loop.
 * Emits B3SseEvent data lines into a ReadableStream<Uint8Array>.
 */

import OpenAI from "openai";
import { getLLMClient, getRoleExtraBody } from "./llm-registry";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { McpManager } from "./mcp-manager";

const log = logger.child({ component: "react-loop" });
import type { Message, TurnContext, AgentConfig, ToolCitation } from "./types";
import type { ToolRegistry } from "./tool-registry";
import type { MemoryCoordinator } from "./memory/memory-coordinator";
import type { PromptBuilder } from "./prompt-builder";
import type { SkillEntry } from "./skills-loader";
import type { LearnerProfile } from "./memory/types";
import { ContextManager } from "./context-manager";
import { createTurnTrace, flushLangfuse } from "./tracing/langfuse-tracer";
import type { LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from "langfuse";

// ---- B3 SSE helpers ---------------------------------------------------------

const _enc = new TextEncoder();

export type ExecutionPayload = {
  language: "python" | "javascript";
  command: string;
  stdout: string;
  stderr: string;
  return_code: number;
};

type B3Event =
  | { type: "text"; content: string }
  | ({ type: "citation" } & ToolCitation)
  | { type: "tool_call"; name: string; tool_call_id?: string; input?: Record<string, unknown> }
  | {
      type: "tool_result";
      name: string;
      success?: boolean;
      duration_ms?: number;
      output?: string;
      execution?: ExecutionPayload;
    }
  | { type: "done"; tokens?: number | null; exec_time_ms?: number | null; error?: string }
  | { type: "trace"; event: string; payload?: Record<string, unknown> }
  | {
      type: "require_approval";
      tool_call_id: string;
      tool_name: string;
      args_preview: Record<string, unknown>;
      approval_key: string;
      reason: string;
      /** Full code for run_script (not sanitised/truncated) */
      full_code?: string;
    }
  | { type: "approval_resolved"; tool_call_id: string; approved: boolean };

function sseData(ev: B3Event): Uint8Array {
  return _enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

// ---- Types ------------------------------------------------------------------

export type ReactLoopOptions = {
  userMessage: string;
  config: AgentConfig;
  toolRegistry: ToolRegistry;
  ctx: TurnContext;
  coordinator: MemoryCoordinator;
  promptBuilder: PromptBuilder;
  skills: SkillEntry[];
  profile: LearnerProfile | null;
  memoryBlock: string;
  /** Prior conversation history (from SessionStore, excludes new user message) */
  history: Message[];
  /** When set, only these tool names are exposed to the LLM (used for eval/benchmark). */
  allowedTools?: string[];
  /** When true, the system prompt is reduced to just the base persona (no safety/tool/course blocks). */
  evalMode?: boolean;
};

type PendingToolCall = { id: string; name: string; args: string };

// ---- Approval gate helpers -------------------------------------------------

const APPROVAL_TTL_SECONDS = 90;
const APPROVAL_POLL_MS = 500;
const APPROVAL_TIMEOUT_MS = 60_000;

/** Writes a pending approval record to Redis and returns the key. */
async function createApprovalRecord(
  sessionId: string,
  toolCallId: string,
  userId: string,
): Promise<string> {
  const key = `agent:approval:${sessionId}:${toolCallId}`;
  const redis = await getRedis();
  await redis.set(
    key,
    JSON.stringify({ approved: null, userId }),
    { EX: APPROVAL_TTL_SECONDS },
  );
  return key;
}

/** Polls Redis until the user responds or the timeout expires.
 *  Returns true if approved, false if denied or timed out. */
async function waitForApproval(
  approvalKey: string,
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const redis = await getRedis();
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, APPROVAL_POLL_MS));
    const raw = await redis.get(approvalKey).catch(() => null);
    if (!raw) return false; // key expired or deleted = deny
    try {
      const record = JSON.parse(raw) as { approved: boolean | null };
      if (record.approved === true) return true;
      if (record.approved === false) return false;
    } catch {
      return false;
    }
  }
  // Timed out — deny by default (least-privilege)
  await redis.del(approvalKey).catch(() => {});
  return false;
}

/** Truncates string values in an args object to protect against very long payloads. */
function sanitiseArgsPreview(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
  }
  return out;
}

// ---- Reflection helper ------------------------------------------------------

type ReflectionResult = { sufficient: boolean; reasoning: string; missing?: string };

/**
 * Calls the LLM (non-streaming, temperature=0) to decide whether the
 * accumulated tool results are sufficient to logically derive an answer to
 * the original question.  Fails open — any exception returns sufficient:true
 * so a single bad reflection call never blocks the agent.
 */
async function _reflectOnToolResults(
  question: string,
  toolResults: string[],
  client: OpenAI,
  model: string,
  extraBody: Record<string, unknown>,
): Promise<ReflectionResult> {
  const combined = toolResults.join("\n\n---\n\n").slice(0, 6000);
  const prompt = [
    "【原始问题】",
    question,
    "",
    "【已检索到的信息】",
    combined,
    "",
    "请判断：",
    "1. 上述信息是否与原始问题直接相关？",
    "2. 基于上述信息，能否进行逻辑推理并得出对原始问题的合理、完整回答？",
    "",
    "以 JSON 格式回复（只输出 JSON，无其他文字）：",
    `{"sufficient": true, "reasoning": "简短说明", "missing": "若不充分则描述缺失信息，否则留空"}`,
  ].join("\n");
  try {
    const resp = (await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是信息充分性评估助手，只输出 JSON，不输出任何其他内容。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 256,
      ...extraBody,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)) as OpenAI.Chat.ChatCompletion;
    const text = resp.choices[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { sufficient: true, reasoning: "parse_error" };
    return JSON.parse(match[0]) as ReflectionResult;
  } catch {
    return { sufficient: true, reasoning: "reflection_error" };
  }
}

// ---- Main entry -------------------------------------------------------------

/**
 * Creates a ReadableStream<Uint8Array> that runs the ReAct loop and emits
 * B3SseEvent data lines. The stream closes after the `done` event.
 */
export function createReActStream(opts: ReactLoopOptions): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  void _runLoop(writer, opts).catch(async (err) => {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, "ReActLoop unhandled error");
    await writer.write(sseData({ type: "done", error })).catch(() => {});
    await writer.close().catch(() => {});
  });

  return readable;
}

async function _runLoop(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  opts: ReactLoopOptions,
): Promise<void> {
  const startMs = Date.now();
  const { config, toolRegistry, coordinator, promptBuilder, skills, profile, memoryBlock } =
    opts;
  // Merge attachments from config into ctx so tools (e.g. read_attachment) can access them.
  const ctx: TurnContext = { ...opts.ctx, attachments: config.attachments };

  const client = getLLMClient("chat");
  const chatExtraBody = getRoleExtraBody("chat");

  // ── Langfuse trace ────────────────────────────────────────────────────────
  let trace: LangfuseTraceClient | null = null;
  let loopSpan: LangfuseSpanClient | null = null;
  let finalAssistantText = "";
  if (ctx.traceId) {
    trace = createTurnTrace({
      traceId: ctx.traceId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      input: opts.userMessage,
      metadata: {
        ...(ctx.courseId ? { courseId: ctx.courseId } : {}),
        ...(ctx.lessonId ? { lessonId: ctx.lessonId } : {}),
        model: config.model,
        maxIterations: config.maxIterations,
      },
    });
    try {
      loopSpan = trace?.span({ name: "react_loop", input: { historyMessages: opts.history.length } }) ?? null;
    } catch { /* noop */ }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Build system prompt
  const systemPrompt = promptBuilder.buildSystemPrompt(
    config.systemPrompt,
    skills,
    memoryBlock,
    profile,
    ctx,
    opts.evalMode,
  );

  // Compress history to fit within the configured context window before building messages.
  const ctxMgr = new ContextManager(config.maxContextTokens);
  const compressedHistory = ctxMgr.compress(opts.history);

  // Prepare messages: system + (compressed) history + new user message
  const loopMsgs: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...compressedHistory.map(_toOpenAIParam),
    { role: "user", content: _buildUserContent(opts) },
  ];

  // Fetch MCP tools (skipped in eval/allowedTools mode for determinism)
  const mcpTools = (opts.allowedTools || opts.evalMode)
    ? []
    : await McpManager.getInstance().getTools().catch((err) => {
        log.warn({ err }, "McpManager.getTools failed, continuing without MCP tools");
        return [];
      });
  const mcpToolMap = new Map(mcpTools.map((t) => [t.name, t]));

  const rawSchemas = [
    ...(opts.allowedTools
      ? toolRegistry.getSchemas().filter((s) => opts.allowedTools!.includes(s.function.name))
      : toolRegistry.getSchemas()),
    ...mcpTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  ];

  // In eval mode, strip the `sources` parameter from knowledge_query so the LLM
  // cannot specify it — the tool will always use the effectiveSource override (course).
  const schemas = opts.evalMode
    ? rawSchemas.map((s) => {
        if (s.function.name !== "knowledge_query") return s;
        const params = s.function.parameters as {
          properties?: Record<string, unknown>;
          required?: string[];
          [k: string]: unknown;
        };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { sources: _removed, ...restProps } = params.properties ?? {};
        return {
          ...s,
          function: {
            ...s.function,
            parameters: {
              ...params,
              properties: restProps,
              required: (params.required ?? []).filter((r) => r !== "sources"),
            },
          },
        };
      })
    : rawSchemas;
  let totalTokens: number | null = null;
  let streamError: string | undefined;

  // Reflection-retry state
  const MAX_REFLECTION_RETRIES = 2;
  const initialLoopMsgs: OpenAI.Chat.ChatCompletionMessageParam[] = [...loopMsgs];
  let reflectionRetry = 0;

  // Emit trace start
  if (ctx.debugTrace) {
    await writer.write(
      sseData({ type: "trace", event: "loop_start", payload: { sessionId: ctx.sessionId } }),
    );
  }

  try {
    let gotFinalAnswer = false;
    let allCollectedToolResults: string[] = [];

    retryLoop: for (; reflectionRetry <= MAX_REFLECTION_RETRIES; reflectionRetry++) {
      if (reflectionRetry > 0) {
        loopMsgs.length = 0;
        loopMsgs.push(...initialLoopMsgs);
        allCollectedToolResults = [];
        if (ctx.debugTrace) {
          await writer.write(
            sseData({ type: "trace", event: "reflection_retry", payload: { retry: reflectionRetry } }),
          );
        }
      }

      for (let iter = 0; iter < config.maxIterations; iter++) {
      const pendingTcs = new Map<number, PendingToolCall>();
      let assistantText = "";
      let iterUsage: { input?: number; output?: number; total?: number } | undefined;

      // Langfuse generation for this LLM call
      let llmGen: LangfuseGenerationClient | null = null;
      try {
        llmGen = loopSpan?.generation({
          name: `llm_call_${iter}`,
          model: config.model,
          input: _truncateMsgsForLangfuse(loopMsgs),
        }) ?? null;
      } catch { /* noop */ }

      // Stream LLM response
      const stream = await client.chat.completions.create({
        model: config.model,
        messages: loopMsgs,
        tools: schemas.length > 0 ? schemas : undefined,
        tool_choice: schemas.length > 0 ? "auto" : undefined,
        stream: true,
        stream_options: { include_usage: true },
        // In eval mode use temperature=0 for deterministic, reproducible answers
        ...(opts.evalMode ? { temperature: 0 } : {}),
        // Disable DeepSeek thinking mode: prevents 400 when reasoning_content not echoed back
        ...chatExtraBody,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          await writer.write(sseData({ type: "text", content: delta.content }));
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!pendingTcs.has(idx)) {
              pendingTcs.set(idx, { id: tc.id ?? `tc_${idx}`, name: "", args: "" });
            }
            const p = pendingTcs.get(idx)!;
            if (tc.function?.name) p.name += tc.function.name;
            if (tc.function?.arguments) p.args += tc.function.arguments;
            if (tc.id && !p.id) p.id = tc.id;
          }
        }
        if (chunk.usage) {
          iterUsage = {
            input: chunk.usage.prompt_tokens ?? undefined,
            output: chunk.usage.completion_tokens ?? undefined,
            total: chunk.usage.total_tokens ?? undefined,
          };
          if (chunk.usage.total_tokens) totalTokens = chunk.usage.total_tokens;
        }
      }

      const toolCallsList = [...pendingTcs.values()].filter((t) => t.name);

      // End Langfuse generation
      try {
        llmGen?.end({
          output:
            toolCallsList.length > 0
              ? { content: assistantText || null, tool_calls: toolCallsList.map((tc) => ({ id: tc.id, name: tc.name })) }
              : assistantText,
          usage: iterUsage ? { ...iterUsage, unit: "TOKENS" as const } : undefined,
        });
      } catch { /* noop */ }

      if (toolCallsList.length === 0) {
        // Final answer — exit loop
        finalAssistantText = assistantText;
        gotFinalAnswer = true;
        break retryLoop;
      }

      // Push assistant message with tool calls
      loopMsgs.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCallsList.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      // Execute each tool
      for (const tc of toolCallsList) {
        // Parse args before emitting so they are included in the tool_call SSE event
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.args) as Record<string, unknown>;
        } catch { /* empty args */ }

        await writer.write(
          sseData({ type: "tool_call", name: tc.name, tool_call_id: tc.id, input: args }),
        );

        const toolStart = Date.now();
        let toolContent = "";
        let citations: ToolCitation[] = [];
        let success = true;

        // Langfuse tool span
        let toolSpan: LangfuseSpanClient | null = null;
        try {
          toolSpan = loopSpan?.span({ name: `tool:${tc.name}`, input: args }) ?? null;
        } catch { /* noop */ }

        const tool = toolRegistry.get(tc.name) ?? mcpToolMap.get(tc.name);
        if (!tool) {
          toolContent = JSON.stringify({ error: `Tool "${tc.name}" not found in registry` });
          success = false;
        } else {
          // ---- Approval gate ------------------------------------------------
          const needsApproval =
            tool.requiresApproval === true &&
            (config.approvalMode ?? "require_user") === "require_user";

          if (needsApproval) {
            const approvalKey = await createApprovalRecord(ctx.sessionId, tc.id, ctx.userId);
            const approvalEvent: B3Event = {
              type: "require_approval",
              tool_call_id: tc.id,
              tool_name: tc.name,
              args_preview: sanitiseArgsPreview(args),
              approval_key: approvalKey,
              reason: tool.approvalReason ?? "此操作需要您的确认。",
              ...(tc.name === "run_script" && typeof args.code === "string"
                ? { full_code: args.code }
                : {}),
            };
            await writer.write(sseData(approvalEvent));
            const approved = await waitForApproval(approvalKey);
            await writer.write(
              sseData({ type: "approval_resolved", tool_call_id: tc.id, approved }),
            );
            if (!approved) {
              toolContent = JSON.stringify({ error: "用户拒绝了此操作。" });
              success = false;
            }
          }
          // -------------------------------------------------------------------

          if (success) {
            try {
              const raw = await tool.execute(args, ctx);
              if (typeof raw === "string") {
                toolContent = raw;
              } else {
                toolContent = raw.content;
                citations = raw.citations ?? [];
              }
            } catch (err) {
              toolContent = JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              });
              success = false;
            }
          }
        }

        const durationMs = Date.now() - toolStart;

        // End Langfuse tool span
        try {
          toolSpan?.end({
            output: toolContent.length > 2000 ? toolContent.slice(0, 2000) + "…" : toolContent,
            metadata: { success, durationMs, category: tool?.category },
            level: success ? ("DEFAULT" as const) : ("WARNING" as const),
          });
        } catch { /* noop */ }

        // For run_script: parse JSON result and build structured execution payload.
        // All other tools retain the 500-char output truncation for LLM context safety.
        let executionPayload: ExecutionPayload | undefined;
        if (tc.name === "run_script" && success) {
          try {
            const parsed = JSON.parse(toolContent) as {
              return_code: number;
              stdout?: string;
              stderr?: string;
            };
            const lang = typeof args.language === "string" &&
              (args.language === "python" || args.language === "javascript")
              ? args.language
              : "python";
            executionPayload = {
              language: lang,
              command: lang === "python" ? "python script.py" : "node script.js",
              stdout: parsed.stdout ?? "",
              stderr: parsed.stderr ?? "",
              return_code: parsed.return_code ?? -1,
            };
          } catch { /* fall through, emit without execution */ }
        }

        await writer.write(
          sseData({
            type: "tool_result",
            name: tc.name,
            success,
            duration_ms: durationMs,
            output: tc.name === "run_script"
              ? toolContent  // no truncation for run_script
              : toolContent.length > 500 ? `${toolContent.slice(0, 500)}...` : toolContent,
            ...(executionPayload ? { execution: executionPayload } : {}),
          }),
        );

        // Emit citations
        for (const c of citations) {
          await writer.write(sseData({ type: "citation", ...c }));
        }

        // Collect successful tool results for reflection
        if (success && toolContent) {
          allCollectedToolResults.push(`[${tc.name}]\n${toolContent.slice(0, 2000)}`);
        }

        // Add tool result to loop messages
        loopMsgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolContent,
        });
      }

      if (ctx.debugTrace) {
        await writer.write(
          sseData({ type: "trace", event: `iter_done`, payload: { iter } }),
        );
      }

      // ── Reflection: verify collected info can support an answer ─────────────────
      if (allCollectedToolResults.length > 0) {
        const reflection = await _reflectOnToolResults(
          opts.userMessage,
          allCollectedToolResults,
          client,
          config.model,
          chatExtraBody as Record<string, unknown>,
        );
        if (ctx.debugTrace) {
          await writer.write(
            sseData({
              type: "trace",
              event: "reflection_result",
              payload: {
                sufficient: reflection.sufficient,
                reasoning: reflection.reasoning,
                missing: reflection.missing,
                retry: reflectionRetry,
              },
            }),
          );
        }
        if (!reflection.sufficient && reflectionRetry < MAX_REFLECTION_RETRIES) {
          // Collected info cannot support an answer — reset and retry from scratch
          continue retryLoop;
        }
      }
    } // end inner for (iter)
    break retryLoop; // maxIterations exhausted without reflection-triggered retry
    } // end retryLoop

    if (!gotFinalAnswer && !streamError) {
      streamError = "MAX_ITERATIONS_REACHED_NO_FINAL_ANSWER";
    } else if (gotFinalAnswer && !finalAssistantText.trim() && !streamError) {
      streamError = "EMPTY_FINAL_ANSWER";
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
    console.error("[ReActLoop] error during loop:", err);
  }

  const execMs = Date.now() - startMs;

  // Close Langfuse observations
  try {
    loopSpan?.end({ output: { totalTokens, execTimeMs: execMs, error: streamError ?? null } });
    if (finalAssistantText) trace?.update({ output: finalAssistantText });
  } catch { /* noop */ }

  await writer.write(
    sseData({ type: "done", tokens: totalTokens, exec_time_ms: execMs, error: streamError }),
  );

  // Fire-and-forget memory consolidation.
  // Include the assistant's final response so the extractor can see the full turn
  // (without it the extractor only receives the user question with no outcome to record).
  const allMessages: Message[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];
  if (finalAssistantText) {
    allMessages.push({ role: "assistant", content: finalAssistantText });
  }
  if (coordinator.shouldRunConsolidation(allMessages)) {
    void coordinator.consolidateSession(ctx.userId, ctx.sessionId, allMessages);
  }

  await writer.close();

  // Flush pending Langfuse events (fire-and-forget after stream closes)
  void flushLangfuse();
}

// ---- Helpers ----------------------------------------------------------------

/** Truncate message content for Langfuse to avoid large payloads. */
function _truncateMsgsForLangfuse(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): unknown {
  return msgs.map((m) => {
    if (typeof m.content === "string" && m.content.length > 1500) {
      return { ...m, content: m.content.slice(0, 1500) + "…" };
    }
    return m;
  });
}

function _toOpenAIParam(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.tool_call_id ?? "",
      content: m.content,
    };
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: tc.function,
      })),
    };
  }
  return { role: m.role as "user" | "assistant" | "system", content: m.content };
}

function _buildUserContent(opts: ReactLoopOptions): string {
  const attachments = opts.config.attachments;
  const imageAtts = attachments?.filter((a) => a.mime_type.startsWith("image/")) ?? [];
  const nonImageAtts = attachments?.filter((a) => !a.mime_type.startsWith("image/")) ?? [];

  let content = opts.userMessage;

  if (imageAtts.length > 0) {
    // Include image URLs as text references so the Agent can pass them to the analyzeImage tool.
    const refs = imageAtts
      .map((a, i) => `  [图片${i + 1}] ${a.name} — ${a.presigned_url}`)
      .join("\n");
    content = `${content}\n\n可用图片（可通过 analyzeImage 工具对图片提问）：\n${refs}`;
  }

  if (nonImageAtts.length > 0) {
    // List non-image attachments so the agent knows they exist and can use read_attachment if needed.
    const idx = nonImageAtts
      .map((a) => `  [附件] ${a.name} (${a.mime_type}) — id: ${a.id}`)
      .join("\n");
    content = `${content}\n\n[附件列表 — 内容已注入上下文，如需完整内容可用 read_attachment(attachment_id=...)]\n${idx}`;
  }

  return content;
}
