/**
 * MemoryConsolidator — aggregates Facts → Concepts → LearnerProfile.
 * Mirrors Python memory/consolidator.py.
 */

import type { MemoryStore } from "./memory-store";
import type { MemoryExtractor } from "./memory-extractor";
import type { Message } from "../types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "memory-consolidator" });

/** Minimum confidence for a Fact to influence Concept mastery */
const CONCEPT_CONFIDENCE_THRESHOLD = 0.6;
/** Mastery delta per unit confidence for mastery facts */
const MASTERY_DELTA_WEIGHT = 0.1;
/** Mastery delta per unit confidence for confusion facts (negative) */
const CONFUSION_DELTA_WEIGHT = 0.05;

export class MemoryConsolidator {
  constructor(
    private store: MemoryStore,
    private extractor: MemoryExtractor,
  ) {}

  async consolidateSession(
    userId: string,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    log.debug({ userId, sessionId, msgCount: messages.length }, "consolidate start");
    // 1. Extract facts from this session
    const newFacts = await this.extractor.extractFactsFromSession(userId, sessionId, messages);
    for (const fact of newFacts) {
      await this.store.addFact(fact);
    }

    if (newFacts.length === 0) return;

    // 2. Aggregate concepts from all facts
    const allFacts = await this.store.listFacts(userId);
    const conceptMap = new Map<string, { mastery: number[]; confusion: number[]; factIds: string[] }>();

    for (const fact of allFacts) {
      if (fact.category !== "concept_mastery" && fact.category !== "concept_confusion") continue;
      // Skip low-confidence observations
      if (fact.confidence < CONCEPT_CONFIDENCE_THRESHOLD) continue;

      // Extract concept name: prefer LLM-provided label, fall back to content heuristic
      const conceptName = _extractConceptName(fact);
      if (!conceptName) continue;

      if (!conceptMap.has(conceptName)) {
        conceptMap.set(conceptName, { mastery: [], confusion: [], factIds: [] });
      }
      const entry = conceptMap.get(conceptName)!;
      entry.factIds.push(fact.id);
      if (fact.category === "concept_mastery") {
        entry.mastery.push(fact.confidence);
      } else {
        entry.confusion.push(fact.confidence);
      }
    }

    // 3. Upsert concepts (recency-weighted: confusion recent → lower mastery)
    const existingConcepts = await this.store.listConcepts(userId);
    const existingMap = new Map(existingConcepts.map((c) => [c.name, c]));
    let createdCount = 0;
    let updatedCount = 0;

    for (const [name, { mastery, confusion, factIds }] of conceptMap) {
      const existing = existingMap.get(name);
      // Delta-based update: preserve accumulated learning history
      // Start from existing mastery level (0.5 for new concepts)
      let delta = 0;
      for (const conf of mastery) delta += MASTERY_DELTA_WEIGHT * conf;
      for (const conf of confusion) delta -= CONFUSION_DELTA_WEIGHT * conf;
      const baseMastery = existing?.masteryLevel ?? 0.5;
      const netMastery = Math.max(0, Math.min(1, baseMastery + delta));
      log.debug({ userId, conceptName: name, op: existing ? "update" : "create", delta, netMastery }, "concept upsert");
      if (existing) updatedCount++; else createdCount++;

      await this.store.saveConcept({
        userId,
        name,
        description: existing?.description ?? "",
        masteryLevel: netMastery,
        supportingFactIds: factIds.slice(0, 20),
        relatedConcepts: existing?.relatedConcepts ?? [],
        metadata: {},
      });
    }

    // 4. Update LearnerProfile snapshot (lightweight — just fact counts + top concepts)
    const topConcepts = [...conceptMap.entries()]
      .sort((a, b) => {
        const aScore = a[1].mastery.length - a[1].confusion.length;
        const bScore = b[1].mastery.length - b[1].confusion.length;
        return bScore - aScore;
      })
      .slice(0, 10)
      .map(([name]) => name);

    log.info({ userId, sessionId, factCount: newFacts.length, created: createdCount, updated: updatedCount }, "consolidate done");

    const currentProfile = await this.store.loadProfile(userId);
    const profileData = {
      ...(currentProfile?.profile ?? {}),
      last_session_id: sessionId,
      top_concepts: topConcepts,
      total_facts: allFacts.length + newFacts.length,
      last_updated: new Date().toISOString(),
    };
    await this.store.saveProfile(userId, profileData);
  }
}

function _extractConceptName(fact: { content: string; metadata?: Record<string, unknown> }): string | null {
  // Prefer LLM-provided concept_label (stored in metadata by extractor)
  const label = fact.metadata?.concept_label;
  if (typeof label === "string" && label.trim().length >= 2) {
    return label.trim().slice(0, 20);
  }
  // Fallback: strip common verb prefixes then use first complete word/phrase
  const trimmed = fact.content.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/^[（(]?[理解掌握学会了解熟悉知道明白不懂困惑混淆]+[）)]?\s*/, "")
    .trim();
  // Take up to the first punctuation or 15 chars, whichever is shorter
  const firstBreak = cleaned.search(/[，。、；！？,.:;!?（(\s]/);
  const name = (firstBreak > 1 ? cleaned.slice(0, firstBreak) : cleaned.slice(0, 15)).trim();
  return name.length >= 2 ? name : null;
}
