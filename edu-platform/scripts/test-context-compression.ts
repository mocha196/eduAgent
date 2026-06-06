/**
 * test-context-compression — Real end-to-end test of ContextManager.
 *
 * Plants a unique sentinel and a fenced code block in the OLDEST user message,
 * then runs both:
 *   1) compress()              — sliding-window
 *   2) compressWithSummary()   — LLM summarisation (falls back to sliding-window on error)
 *
 * Dumps before/after JSON snapshots so we can verify what survives.
 *
 * Run: npx tsx scripts/test-context-compression.ts
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ContextManager, estimateTokens } from "@/lib/agent/context-manager";
import { getLLMClient, getMemoryModel } from "@/lib/agent/llm-registry";
import type { Message } from "@/lib/agent/types";

const SENTINEL = "X7Q-MAGIC-PHRASE-DO-NOT-PARAPHRASE-42";
const CODE_BLOCK = [
  "```python",
  "def fibonacci(n: int) -> int:",
  "    if n < 2:",
  "        return n",
  "    return fibonacci(n - 1) + fibonacci(n - 2)",
  "",
  "# CODE_SENTINEL_BLOCK_777",
  "assert fibonacci(10) == 55",
  "```",
].join("\n");

function makeHistory(): Message[] {
  const sys: Message = {
    role: "system",
    content: "你是教学助手。",
  };

  const oldestUser: Message = {
    role: "user",
    content:
      `这是第 1 轮：${SENTINEL}\n\n` +
      `请记住我下面贴的这段斐波那契代码，它会反复用到。\n\n` +
      `${CODE_BLOCK}\n\n` +
      `特别注意里面那行 \`# CODE_SENTINEL_BLOCK_777\`，` +
      `我之后会问你它在第几行。`,
  };
  const oldestAssistant: Message = {
    role: "assistant",
    content:
      "好的，我已经记住这段递归实现的斐波那契函数和你提到的注释。" +
      "递归基线是 n<2 时返回 n。",
  };

  // Filler turns to balloon token count (kept short so LLM summary stays fast).
  const FILLER_TURNS = 10;
  const filler: Message[] = [];
  for (let i = 2; i <= FILLER_TURNS + 1; i++) {
    filler.push({
      role: "user",
      content: `第 ${i} 轮：解释一下 TCP 滑动窗口里的接收窗口和拥塞窗口的区别。`,
    });
    filler.push({
      role: "assistant",
      content:
        `第 ${i} 轮回答：接收窗口 rwnd 由接收方根据缓冲区剩余通告；` +
        `拥塞窗口 cwnd 由发送方依据网络状况维护。实际发送窗口取两者最小值。`,
    });
  }

  const recentUser: Message = {
    role: "user",
    content:
      `最新一轮：还记得我最开始贴的那段 Python 代码吗？` +
      `里面的注释行内容是什么？同时请复述一下我在第 1 轮说的那串口令。`,
  };

  return [sys, oldestUser, oldestAssistant, ...filler, recentUser];
}

function summarize(messages: Message[], label: string) {
  return {
    label,
    count: messages.length,
    tokens: estimateTokens(messages),
    roles: messages.map((m) => m.role),
    hasSentinel: messages.some((m) => typeof m.content === "string" && m.content.includes(SENTINEL)),
    hasCodeBlock: messages.some((m) => typeof m.content === "string" && m.content.includes("CODE_SENTINEL_BLOCK_777")),
    hasFibDef: messages.some((m) => typeof m.content === "string" && m.content.includes("def fibonacci")),
  };
}

async function main() {
  const history = makeHistory();
  const limit = 400; // chars/4 ≈ tokens — easily exceeded by the synthetic history

  console.log("=== INPUT ===");
  console.log(JSON.stringify(summarize(history, "input"), null, 2));

  const cm = new ContextManager(limit);

  // --- Strategy 1: sliding window ---
  const sliding = cm.compress(history);
  console.log("\n=== AFTER sliding-window compress ===");
  console.log(JSON.stringify(summarize(sliding, "sliding"), null, 2));

  // --- Strategy 2: LLM summary ---
  const llm = getLLMClient("memory");
  const model = getMemoryModel();
  console.log(`\nCalling LLM summary using model=${model} ...`);
  const { messages: summarized, didSummarize } = await cm.compressWithSummary(
    history,
    llm,
    model,
  );
  console.log(`didSummarize=${didSummarize}`);
  console.log("=== AFTER summary compress ===");
  console.log(JSON.stringify(summarize(summarized, "summary"), null, 2));

  // --- Dump full JSON to disk ---
  const outDir = path.resolve(process.cwd(), "output", "context-compression");
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = path.join(outDir, `dump-${stamp}.json`);
  writeFileSync(
    dumpPath,
    JSON.stringify(
      {
        limit,
        sentinel: SENTINEL,
        input: history,
        sliding,
        summary: summarized,
        didSummarize,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nFull dump written to: ${dumpPath}`);

  // --- Verdict ---
  const slidingS = summarize(sliding, "sliding");
  const summaryS = summarize(summarized, "summary");
  console.log("\n=== VERDICT ===");
  console.log(`sliding kept sentinel?  ${slidingS.hasSentinel}  code?  ${slidingS.hasCodeBlock}`);
  console.log(`summary kept sentinel?  ${summaryS.hasSentinel}  code?  ${summaryS.hasCodeBlock}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
