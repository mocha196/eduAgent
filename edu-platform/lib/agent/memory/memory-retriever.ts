/**
 * MemoryRetriever — TF-IDF keyword matching for relevant concepts.
 * Mirrors Python memory/retriever.py (no embedding required).
 */

import type { Concept } from "./types";
import type { MemoryStore } from "./memory-store";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "memory-retriever" });

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。、！？!?;；:：\-—]+/)
    .filter((t) => t.length > 1);
}

function score(query: string[], concept: Concept): number {
  const haystack = [
    concept.name,
    concept.description,
    ...concept.relatedConcepts,
  ]
    .join(" ")
    .toLowerCase();

  let hits = 0;
  for (const token of query) {
    if (haystack.includes(token)) hits++;
  }
  // Boost by mastery level so well-known concepts surface first
  return hits + concept.masteryLevel * 0.1;
}

export class MemoryRetriever {
  constructor(private store: MemoryStore) {}

  async getRelevantConcepts(
    userId: string,
    query: string,
    maxResults = 6,
  ): Promise<Concept[]> {
    const concepts = await this.store.listConcepts(userId);
    if (concepts.length === 0) return [];

    const tokens = tokenize(query);
    if (tokens.length === 0) return concepts.slice(0, maxResults);

    const scored = concepts
      .map((c) => ({ c, s: score(tokens, c) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s);

    const result = scored.slice(0, maxResults).map(({ c }) => c);
    log.debug({ userId, query: query.slice(0, 60), conceptCount: result.length }, "concepts retrieved");
    return result;
  }
}
