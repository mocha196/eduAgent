/**
 * Langfuse Cloud tracing adapter for the TS ReAct agent.
 *
 * Returns null (noop) when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set,
 * so this module is safe to import unconditionally — it degrades gracefully.
 */

import {
  Langfuse,
  type LangfuseGenerationClient,
  type LangfuseTraceClient,
} from "langfuse";
import { getLangfuseConfig } from "@/lib/config";

// Lazy singleton — undefined means "not yet initialised"
let _client: Langfuse | null | undefined = undefined;

function getClient(): Langfuse | null {
  if (_client !== undefined) return _client;
  const cfg = getLangfuseConfig();
  if (!cfg) {
    _client = null;
    return null;
  }
  _client = new Langfuse({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    // Batch-send up to 20 events or every 3 s, whichever comes first.
    flushAt: 20,
    flushInterval: 3000,
  });
  return _client;
}

/**
 * Create (or reference) a Langfuse trace for one agent turn.
 * Returns null if Langfuse is not configured.
 */
export function createTurnTrace(opts: {
  traceId: string;
  userId: string;
  sessionId: string;
  /** Raw user message (before image-description injection). */
  input: string;
  metadata?: Record<string, unknown>;
}): LangfuseTraceClient | null {
  try {
    const client = getClient();
    if (!client) return null;
    return client.trace({
      id: opts.traceId,
      name: "edu_turn",
      userId: opts.userId,
      sessionId: opts.sessionId,
      input: opts.input,
      metadata: opts.metadata,
      tags: ["edu-platform"],
    });
  } catch (err) {
    console.warn("[Langfuse] createTurnTrace failed:", err);
    return null;
  }
}

/**
 * Flush all pending Langfuse events.
 * Call fire-and-forget after the response stream closes.
 */
export async function flushLangfuse(): Promise<void> {
  try {
    await _client?.flushAsync();
  } catch {
    // non-fatal — tracing must never break the main flow
  }
}

/**
 * Create a standalone Langfuse trace for auxiliary LLM calls that are
 * not part of the main ReAct loop (e.g. grading, feedback, memory extraction).
 * Returns null when Langfuse is not configured.
 */
export function createStandaloneTrace(opts: {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
}): LangfuseTraceClient | null {
  try {
    const client = getClient();
    if (!client) return null;
    return client.trace({
      name: opts.name,
      input: opts.input,
      metadata: opts.metadata,
      userId: opts.userId,
      sessionId: opts.sessionId,
      tags: ["edu-platform"],
    });
  } catch (err) {
    console.warn("[Langfuse] createStandaloneTrace failed:", err);
    return null;
  }
}

/**
 * Record a single LLM generation on *trace* and close it immediately.
 * Safe to call with a null trace (no-op).
 */
export function recordGeneration(
  trace: LangfuseTraceClient | null,
  opts: {
    name: string;
    model: string;
    input: unknown;
    output?: unknown;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    metadata?: Record<string, unknown>;
  },
): LangfuseGenerationClient | null {
  if (!trace) return null;
  try {
    const gen = trace.generation({
      name: opts.name,
      model: opts.model,
      input: opts.input,
      output: opts.output,
      usage: opts.usage,
      metadata: opts.metadata,
    });
    if (opts.output !== undefined) {
      gen.end({ output: opts.output, usage: opts.usage });
      return null;
    }
    return gen;
  } catch (err) {
    console.warn("[Langfuse] recordGeneration failed:", err);
    return null;
  }
}
