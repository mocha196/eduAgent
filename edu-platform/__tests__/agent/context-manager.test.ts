import { describe, it, expect, vi, type MockInstance } from "vitest";
import { ContextManager, estimateTokens } from "@/lib/agent/context-manager";
import type { Message } from "@/lib/agent/types";
import type OpenAI from "openai";

describe("ContextManager", () => {
  it("业务规则：在 token 未超限时应保留完整上下文", () => {
    // given
    const messages: Message[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "什么是 TCP 三次握手？" },
      { role: "assistant", content: "我来分步解释。" },
    ];
    const manager = new ContextManager(1000);

    // when
    const compressed = manager.compress(messages);

    // then
    expect(compressed).toEqual(messages);
    expect(estimateTokens(compressed)).toBeLessThanOrEqual(1000);
  });

  it("业务规则：超限时应优先保留 system 与最近对话", () => {
    // given
    const messages: Message[] = [
      { role: "system", content: "你是教学助手" },
      { role: "user", content: "old-1".repeat(80) },
      { role: "assistant", content: "old-2".repeat(80) },
      { role: "user", content: "recent-question" },
      { role: "assistant", content: "recent-answer" },
    ];
    const manager = new ContextManager(60);

    // when
    const compressed = manager.compress(messages);

    // then
    expect(compressed[0]).toEqual(messages[0]);
    expect(compressed.some((m) => m.content.includes("recent-question"))).toBe(true);
    expect(compressed.some((m) => m.content.includes("recent-answer"))).toBe(true);
    expect(compressed.some((m) => m.content.includes("old-1"))).toBe(false);
  });

  it("业务规则：即使超限也至少保留最后两条业务消息", () => {
    // given
    const messages: Message[] = [
      { role: "user", content: "a".repeat(300) },
      { role: "assistant", content: "b".repeat(300) },
      { role: "user", content: "最后一个问题".repeat(200) },
      { role: "assistant", content: "最后一个回答".repeat(200) },
    ];
    const manager = new ContextManager(10);

    // when
    const compressed = manager.compress(messages);

    // then
    expect(compressed.slice(-2)).toEqual([
      { role: "user", content: "最后一个问题".repeat(200) },
      { role: "assistant", content: "最后一个回答".repeat(200) },
    ]);
  });

  it("业务规则：带 tool_calls 的消息应计入 token 预算", () => {
    // given
    const withToolCalls: Message[] = [
      {
        role: "assistant",
        content: "调用工具",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "knowledge_query", arguments: '{"question":"x"}' },
          },
        ],
      },
    ];
    const withoutToolCalls: Message[] = [{ role: "assistant", content: "调用工具" }];

    // when
    const a = estimateTokens(withToolCalls);
    const b = estimateTokens(withoutToolCalls);

    // then
    expect(a).toBeGreaterThan(b);
  });
});

// ---- Helper to build a mock OpenAI client ---------------------------------

function makeMockLlmClient(summaryText: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: summaryText } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

function makeFaultyLlmClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      },
    },
  } as unknown as OpenAI;
}

// ---- compressWithSummary ---------------------------------------------------

describe("ContextManager.compressWithSummary", () => {
  it("未超限时应原样返回且 didSummarize 为 false", async () => {
    const messages: Message[] = [
      { role: "system", content: "系统" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
    ];
    const mgr = new ContextManager(1000);
    const mockClient = makeMockLlmClient("摘要内容");

    const result = await mgr.compressWithSummary(messages, mockClient, "test-model");

    expect(result.didSummarize).toBe(false);
    expect(result.messages).toEqual(messages);
    // LLM should not have been called
    expect(
      (mockClient.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("超限且有足够旧消息时应调用 LLM 并注入摘要消息对", async () => {
    // Build a history that far exceeds a tiny limit
    const old1: Message = { role: "user", content: "old-question".repeat(30) };
    const old2: Message = { role: "assistant", content: "old-answer".repeat(30) };
    const old3: Message = { role: "user", content: "old-question-2".repeat(30) };
    const old4: Message = { role: "assistant", content: "old-answer-2".repeat(30) };
    const recent: Message[] = [
      { role: "user", content: "recent-q1" },
      { role: "assistant", content: "recent-a1" },
      { role: "user", content: "recent-q2" },
      { role: "assistant", content: "recent-a2" },
      { role: "user", content: "recent-q3" },
      { role: "assistant", content: "recent-a3" },
    ];
    const system: Message = { role: "system", content: "系统提示" };
    const messages: Message[] = [system, old1, old2, old3, old4, ...recent];

    // Limit is tiny so everything overflows; recentKeep=6 matches recent array length
    const mgr = new ContextManager(50);
    const mockClient = makeMockLlmClient("这是LLM生成的历史摘要。");

    const result = await mgr.compressWithSummary(messages, mockClient, "test-model", {
      recentKeep: 6,
    });

    expect(result.didSummarize).toBe(true);
    // System message preserved at position 0
    expect(result.messages[0]).toEqual(system);
    // Next two are the injected summary pair
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toContain("[对话历史摘要]");
    expect(result.messages[1].content).toContain("这是LLM生成的历史摘要。");
    expect(result.messages[2].role).toBe("assistant");
    // Last 6 are the recent messages
    expect(result.messages.slice(-6)).toEqual(recent);
    // Old messages should not appear
    expect(result.messages.some((m) => m.content.includes("old-question"))).toBe(false);
  });

  it("LLM 调用失败时应回退到滑动窗口且 didSummarize 为 false", async () => {
    const old: Message = { role: "user", content: "old".repeat(200) };
    const recent1: Message = { role: "user", content: "recent1" };
    const recent2: Message = { role: "assistant", content: "recent2" };
    const system: Message = { role: "system", content: "s" };
    const messages = [system, old, recent1, recent2];

    const mgr = new ContextManager(20); // tiny limit to force compression
    const faultyClient = makeFaultyLlmClient();

    const result = await mgr.compressWithSummary(messages, faultyClient, "test-model", {
      recentKeep: 2,
    });

    expect(result.didSummarize).toBe(false);
    // Sliding-window result: system + recent messages that fit
    expect(result.messages[0]).toEqual(system);
    expect(result.messages.some((m) => m.content.includes("old"))).toBe(false);
    expect(result.messages.some((m) => m.content === "recent1" || m.content === "recent2")).toBe(
      true,
    );
  });

  it("非系统消息总数 <= recentKeep 时应回退到滑动窗口", async () => {
    const messages: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u".repeat(500) },
      { role: "assistant", content: "a".repeat(500) },
    ];
    const mgr = new ContextManager(10); // tiny → over limit
    const mockClient = makeMockLlmClient("摘要");

    const result = await mgr.compressWithSummary(messages, mockClient, "test-model", {
      recentKeep: 6,
    });

    // rest.length (2) <= recentKeep (6) → fall back to sliding-window, no LLM call
    expect(result.didSummarize).toBe(false);
    expect(
      (mockClient.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });
});
