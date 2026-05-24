/**
 * Agent setup — creates and wires all TS Agent components.
 * Call once at module init; the returned objects are safe to share across requests.
 */

import OpenAI from "openai";

import { getLLMClient, getChatModel, getMemoryModel } from "./llm-registry";
import { SessionStore } from "./session-store";
import { ContextManager } from "./context-manager";
import { promptBuilder } from "./prompt-builder";
import { memoryStore } from "./memory/memory-store";
import { MemoryRetriever } from "./memory/memory-retriever";
import { MemoryExtractor } from "./memory/memory-extractor";
import { MemoryConsolidator } from "./memory/memory-consolidator";
import { MemoryCoordinator } from "./memory/memory-coordinator";
import { toolRegistry } from "./tools/index";
import type { AgentConfig } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "setup" });

// ---- Base persona (fallback if EDUCATOR.md not present) -------------------

const DEFAULT_PERSONA = `# 角色：智能教学助手

你是一位耐心、专业、富有启发性的 AI 教学助手。你的目标是帮助学习者深入理解知识，培养独立思考能力，而不仅仅是提供答案。

## 教学原则
- **以学习者为中心**：根据学习者的水平调整语言难度和解释深度。
- **启发引导**：尽量通过提问引导学习者自己得出结论，而非直接给出答案。
- **及时反馈**：对学习者的回答给予具体、积极的反馈，指出不足时保持鼓励性语气。
- **学科准确性**：确保所有知识性内容准确；不确定时如实说明并提示查阅权威来源。`;

// ---- OpenAI client (delegates to llm-registry) ----------------------------

/** @deprecated Use getLLMClient(role) from llm-registry instead. */
export function buildOpenAIClient(): OpenAI {
  return getLLMClient("chat");
}

// ---- Singleton agent components --------------------------------------------

let _coordinator: MemoryCoordinator | null = null;
let _openaiClient: OpenAI | null = null;

export function getMemoryCoordinator(): MemoryCoordinator {
  if (_coordinator) return _coordinator;

  _openaiClient = _openaiClient ?? getLLMClient("memory");
  const model = getMemoryModel();

  const retriever = new MemoryRetriever(memoryStore);
  const extractor = new MemoryExtractor(_openaiClient, model);
  const consolidator = new MemoryConsolidator(memoryStore, extractor);
  _coordinator = new MemoryCoordinator(retriever, consolidator);
  log.info({ model }, "MemoryCoordinator initialized");
  return _coordinator;
}

// ---- SkillsLoader ----------------------------------------------------------
// Singleton and config loading live in skills-loader.ts to avoid circular
// imports (tools/skills.ts → skills-loader.ts, tools/index.ts → setup.ts).
export { getSkillsLoader } from "./skills-loader";

// ---- AgentConfig builder --------------------------------------------------

const EVAL_PERSONA = `You are a retrieval-augmented question answering system.
Always call knowledge_query FIRST — do NOT output any text before the first tool call.
You may call knowledge_query up to 3 times with different English queries to gather all needed information.
After all tool calls are done, output only the final answer: direct, concise, and grounded strictly in the retrieved content.
Do NOT narrate your retrieval process or explain what you are about to do.

**Retrieval language:** Always use English for knowledge_query queries regardless of the question's language.

**Answer language:** Answer in the same language as the question (Chinese question → Chinese answer; English → English).`;

export function buildAgentConfig(
  attachments?: AgentConfig["attachments"],
  evalMode?: boolean,
): AgentConfig {
  return {
    model: getChatModel(),
    systemPrompt: evalMode ? EVAL_PERSONA : DEFAULT_PERSONA,
    maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS ?? "8", 10),
    ragServiceUrl: process.env.RAG_SERVICE_URL ?? "http://localhost:8001",
    ragServiceKey: process.env.RAG_SERVICE_API_KEY ?? "",
    maxContextTokens: parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS ?? "120000", 10),
    attachments,
  };
}

// ---- Re-exports for convenience --------------------------------------------

export {
  sessionStore,
} from "./session-store";

export {
  promptBuilder,
  toolRegistry,
  memoryStore,
  SessionStore,
  ContextManager,
};
