/**
 * MemoryCoordinator — entry point for the ReAct loop.
 * Mirrors Python memory/coordinator.py.
 */

import type { Message } from "../types";
import type { MemoryRetriever } from "./memory-retriever";
import type { MemoryConsolidator } from "./memory-consolidator";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "memory-coordinator" });
const MEMORY_INJECT_MAX_CHARS = 1200;

export class MemoryCoordinator {
  constructor(
    private retriever: MemoryRetriever,
    private consolidator: MemoryConsolidator,
  ) {}

  /**
   * Returns a text block to inject into the system prompt before each turn.
   * Empty string if no relevant concepts are found.
   */
  async buildRetrievedMemoryBlock(userId: string, userHint: string): Promise<string> {
    const hint = userHint.trim();
    if (!hint) return "";

    try {
      const concepts = await this.retriever.getRelevantConcepts(userId, hint, 6);
      if (concepts.length === 0) return "";
      log.debug({ userId, conceptCount: concepts.length }, "memory block built");

      const lines = concepts.map(
        (c) => `- ${c.name}（掌握度 ${c.masteryLevel.toFixed(2)}）`,
      );
      let block = lines.join("\n");
      if (block.length > MEMORY_INJECT_MAX_CHARS) {
        block = block.slice(0, MEMORY_INJECT_MAX_CHARS) + "…";
      }
      return block;
    } catch {
      return "";
    }
  }

  /**
   * Returns true whenever the session contains at least one user message.
   * Extraction runs after every conversation turn (Mem0-style immediate extraction).
   * The extractor returns [] for trivial exchanges, so false-positive cost is negligible.
   */
  shouldRunConsolidation(messages: Message[]): boolean {
    return messages.some((m) => m.role === "user");
  }

  /**
   * Run extractor + consolidator pipeline (called asynchronously, not awaited by the loop).
   */
  async consolidateSession(
    userId: string,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    log.debug({ userId, sessionId }, "consolidation dispatched");
    try {
      await this.consolidator.consolidateSession(userId, sessionId, messages);
    } catch (err) {
      log.error({ err, userId, sessionId }, "[MemoryCoordinator] consolidation failed");
    }
  }
}
