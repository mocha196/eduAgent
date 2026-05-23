import { describe, it, expect, vi } from "vitest";
import { MemoryCoordinator } from "@/lib/agent/memory/memory-coordinator";
import type { Message } from "@/lib/agent/types";

describe("MemoryCoordinator", () => {
  it("业务规则：用户提示为空时不应注入记忆块", async () => {
    // given
    const retriever = { getRelevantConcepts: vi.fn() };
    const consolidator = { consolidateSession: vi.fn() };
    const coordinator = new MemoryCoordinator(retriever as never, consolidator as never);

    // when
    const block = await coordinator.buildRetrievedMemoryBlock("u-1", "   ");

    // then
    expect(block).toBe("");
    expect(retriever.getRelevantConcepts).not.toHaveBeenCalled();
  });

  it("业务规则：检索到概念时应生成可读记忆块并按长度截断", async () => {
    // given
    const retriever = {
      getRelevantConcepts: vi.fn(async () => [
        { name: "TCP", masteryLevel: 0.8 },
        { name: "拥塞控制", masteryLevel: 0.3 },
        { name: "超长概念", masteryLevel: 0.5 },
      ]),
    };
    const consolidator = { consolidateSession: vi.fn() };
    const coordinator = new MemoryCoordinator(retriever as never, consolidator as never);

    // when
    const block = await coordinator.buildRetrievedMemoryBlock("u-1", "复习传输层");

    // then
    expect(block).toContain("TCP（掌握度 0.80）");
    expect(block).toContain("拥塞控制（掌握度 0.30）");
    expect(block.length).toBeLessThanOrEqual(1201);
  });

  it("业务规则：记忆检索失败时不应中断主流程，应返回空字符串", async () => {
    // given
    const retriever = {
      getRelevantConcepts: vi.fn(async () => {
        throw new Error("retriever down");
      }),
    };
    const consolidator = { consolidateSession: vi.fn() };
    const coordinator = new MemoryCoordinator(retriever as never, consolidator as never);

    // when
    const block = await coordinator.buildRetrievedMemoryBlock("u-1", "传输层");

    // then
    expect(block).toBe("");
  });

  it("业务规则：有用户消息时应触发 consolidation（即时提取）", () => {
    // given
    const retriever = { getRelevantConcepts: vi.fn() };
    const consolidator = { consolidateSession: vi.fn() };
    const coordinator = new MemoryCoordinator(retriever as never, consolidator as never);

    // when / then
    // A: 空消息 → 不触发
    expect(coordinator.shouldRunConsolidation([])).toBe(false);
    // B: 只有 assistant 消息（理论上不应发生，但边界安全）→ 不触发
    const assistantOnly: Message[] = [{ role: "assistant", content: "你好" }];
    expect(coordinator.shouldRunConsolidation(assistantOnly)).toBe(false);
    // C: 包含 user 消息（单条）→ 触发
    const oneUser: Message[] = [{ role: "user", content: "短消息" }];
    expect(coordinator.shouldRunConsolidation(oneUser)).toBe(true);
    // D: 多轮对话 → 触发
    const multiTurn: Message[] = [
      { role: "user", content: "TCP 拥塞控制是什么？" },
      { role: "assistant", content: "TCP 拥塞控制是..." },
      { role: "user", content: "慢启动算法呢？" },
    ];
    expect(coordinator.shouldRunConsolidation(multiTurn)).toBe(true);
  });

  it("业务规则：consolidation 失败不应向用户层抛错", async () => {
    // given
    const retriever = { getRelevantConcepts: vi.fn() };
    const consolidator = {
      consolidateSession: vi.fn(async () => {
        throw new Error("llm timeout");
      }),
    };
    const coordinator = new MemoryCoordinator(retriever as never, consolidator as never);

    // when
    const action = coordinator.consolidateSession("u-1", "s-1", [
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ]);

    // then
    await expect(action).resolves.toBeUndefined();
  });
});
