/**
 * MemoryStore — Prisma-backed CRUD for Facts, Concepts, LearnerProfile.
 * Mirrors Python memory/storage.py (Phase 3B replacement).
 */

import { prisma } from "@/lib/db";
import type { Fact, Concept, LearnerProfile } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "memory-store" });

export class MemoryStore {
  // ---- Facts (append-only) ------------------------------------------------

  async addFact(fact: Omit<Fact, "id">): Promise<void> {
    log.debug({ userId: fact.userId, category: fact.category, confidence: fact.confidence }, "addFact");
    await prisma.userMemoryFact.create({
      data: {
        userId: fact.userId,
        sessionId: fact.sessionId,
        timestamp: fact.timestamp,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        sourceJson: fact.sourceJson as object,
        metadata: (fact.metadata ?? {}) as object,
      },
    });
  }

  async listFacts(userId: string, since?: Date): Promise<Fact[]> {
    const rows = await prisma.userMemoryFact.findMany({
      where: {
        userId,
        ...(since ? { timestamp: { gte: since } } : {}),
      },
      orderBy: { timestamp: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      sessionId: r.sessionId,
      timestamp: r.timestamp,
      category: r.category as Fact["category"],
      content: r.content,
      confidence: r.confidence,
      sourceJson: r.sourceJson as Fact["sourceJson"],
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  // ---- Concepts (upsert by userId+name) -----------------------------------

  async saveConcept(concept: Omit<Concept, "id" | "lastUpdated">): Promise<void> {
    log.debug({ userId: concept.userId, conceptName: concept.name, masteryLevel: concept.masteryLevel }, "saveConcept");
    await prisma.userMemoryConcept.upsert({
      where: { userId_name: { userId: concept.userId, name: concept.name } },
      create: {
        userId: concept.userId,
        name: concept.name,
        description: concept.description,
        masteryLevel: concept.masteryLevel,
        supportingFactIds: concept.supportingFactIds,
        relatedConcepts: concept.relatedConcepts,
        metadata: (concept.metadata ?? {}) as object,
      },
      update: {
        description: concept.description,
        masteryLevel: concept.masteryLevel,
        supportingFactIds: concept.supportingFactIds,
        relatedConcepts: concept.relatedConcepts,
        metadata: (concept.metadata ?? {}) as object,
      },
    });
  }

  async listConcepts(userId: string): Promise<Concept[]> {
    const rows = await prisma.userMemoryConcept.findMany({
      where: { userId },
      orderBy: { lastUpdated: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      description: r.description,
      masteryLevel: r.masteryLevel,
      lastUpdated: r.lastUpdated,
      supportingFactIds: r.supportingFactIds,
      relatedConcepts: r.relatedConcepts,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  // ---- LearnerProfile (upsert by userId) ----------------------------------

  async saveProfile(userId: string, profile: Record<string, unknown>): Promise<void> {
    await prisma.userLearningProfile.upsert({
      where: { userId },
      create: { userId, profile: profile as object },
      update: { profile: profile as object },
    });
  }

  async loadProfile(userId: string): Promise<LearnerProfile | null> {
    const row = await prisma.userLearningProfile.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      profile: row.profile as Record<string, unknown>,
      updatedAt: row.updatedAt,
    };
  }
}

export const memoryStore = new MemoryStore();
