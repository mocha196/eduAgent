/**
 * ContextManager — token estimation and history compression.
 *
 * Two strategies:
 *  - compress()              – synchronous sliding-window (fast, no LLM call)
 *  - compressWithSummary()   – async LLM-based summarisation of older turns;
 *                              falls back to sliding-window on error.
 *
 * Uses a simple char-based approximation (1 token ≈ 4 chars for Chinese/English mix).
 * For production accuracy, replace with a WASM tiktoken binding.
 */

import OpenAI from "openai";
import type { Message } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "context-manager" });

const CHARS_PER_TOKEN = 4;

function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead
    total += estimateTokensForText(m.content);
    if (m.tool_calls) {
      total += estimateTokensForText(JSON.stringify(m.tool_calls));
    }
  }
  return total;
}

export class ContextManager {
  private maxTokens: number;

  constructor(maxTokens = 32_000) {
    this.maxTokens = maxTokens;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }

  /**
   * Compress history to fit within maxTokens.
   *
   * Strategy:
   *  1. Always keep the system message (index 0, if present).
   *  2. Always keep the last 6 messages (recent context).
   *  3. Drop oldest messages from the middle until we fit.
   *
   * This is a simple sliding-window; use compressWithSummary() for LLM-based compression.
   */
  compress(messages: Message[], maxTokens?: number): Message[] {
    const limit = maxTokens ?? this.maxTokens;
    if (estimateTokens(messages) <= limit) return messages;

    log.debug({ before: messages.length, tokensBefore: estimateTokens(messages), limit }, "context compress triggered");

    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;

    // Keep the last N messages that fit
    let kept: Message[] = [];
    let tokens = estimateTokens(system);
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = estimateTokens([rest[i]]);
      if (tokens + t > limit) break;
      kept.unshift(rest[i]);
      tokens += t;
    }

    // Ensure at minimum the last 2 messages are kept (user + previous assistant)
    if (kept.length === 0 && rest.length > 0) {
      kept = rest.slice(-2);
    }

    return [...system, ...kept];
  }

  /**
   * Async LLM-based compression: summarises older turns into a single message pair,
   * keeping the most recent `recentKeep` messages intact.
   *
   * Falls back to the synchronous sliding-window if:
   *  - history is already within the token budget
   *  - there are not enough old messages to summarise (≤ recentKeep total non-system msgs)
   *  - the LLM call fails for any reason
   *
   * Returns `{ messages, didSummarize }` so the caller can decide whether to persist.
   *
   * @param messages   Full conversation history (may include a leading system message).
   * @param llmClient  OpenAI-compatible client for the summary model.
   * @param model      Model identifier to use for summarisation.
   * @param options    Optional overrides: `recentKeep` (default 6).
   */
  async compressWithSummary(
    messages: Message[],
    llmClient: OpenAI,
    model: string,
    options?: { recentKeep?: number },
  ): Promise<{ messages: Message[]; didSummarize: boolean }> {
    if (estimateTokens(messages) <= this.maxTokens) {
      return { messages, didSummarize: false };
    }

    const recentKeep = options?.recentKeep ?? parseInt(process.env.AGENT_SUMMARY_RECENT_KEEP ?? "6", 10);
    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const rest = system.length > 0 ? messages.slice(1) : messages;

    if (rest.length <= recentKeep) {
      // Not enough turns to split into old + recent; fall back to sliding-window.
      return { messages: this.compress(messages), didSummarize: false };
    }

    const toSummarize = rest.slice(0, rest.length - recentKeep);
    const recent = rest.slice(rest.length - recentKeep);

    try {
      const summaryText = await this._callSummaryLLM(toSummarize, llmClient, model);

      // Extract fenced code blocks from compressed messages so they survive summarisation.
      const codeBlockRegex = /```[\s\S]*?```/g;
      const extractedCodes: string[] = [];
      for (const msg of toSummarize) {
        if (msg.role !== "user") continue;
        const text = typeof msg.content === "string" ? msg.content : "";
        const blocks = text.match(codeBlockRegex);
        if (blocks) extractedCodes.push(...blocks);
      }
      const codeAppendix =
        extractedCodes.length > 0
          ? `\n\n[最近代码片段（压缩前保留）]\n${extractedCodes.join("\n\n").slice(0, 2000)}`
          : "";

      const summaryMessages: Message[] = [
        { role: "user", content: `[对话历史摘要]\n${summaryText}${codeAppendix}` },
        { role: "assistant", content: "好的，我已了解之前的对话内容，我们继续。" },
      ];
      return {
        messages: [...system, ...summaryMessages, ...recent],
        didSummarize: true,
      };
    } catch (err) {
      console.warn("[ContextManager] LLM summary failed, falling back to sliding-window:", err);
      return { messages: this.compress(messages), didSummarize: false };
    }
  }

  private async _callSummaryLLM(
    messages: Message[],
    llmClient: OpenAI,
    model: string,
  ): Promise<string> {
    const formatted = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "学习者" : "助手"}: ${m.content}`)
      .join("\n\n");

    const resp = await llmClient.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content:
            `请将以下教学对话历史压缩为简洁摘要（约200字），保留学习者的核心问题、` +
            `助手的关键解答、重要概念和知识点、学习进展。用与对话相同的语言输出。\n\n` +
            `对话历史：\n${formatted}\n\n摘要：`,
        },
      ],
      max_tokens: 512,
      temperature: 0.3,
    });

    const text = resp.choices[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty summary response from LLM");
    return text;
  }
}
