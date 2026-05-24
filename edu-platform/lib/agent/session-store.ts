/**
 * SessionStore — stores Message[] in Redis.
 * Key: agent:session:{sessionId}  TTL: 24 h
 */

import { getRedis } from "@/lib/redis";
import type { Message } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "session-store" });
const TTL_SECONDS = 24 * 60 * 60;

function _key(sessionId: string): string {
  return `agent:session:${sessionId}`;
}

export class SessionStore {
  async get(sessionId: string): Promise<Message[]> {
    const redis = await getRedis();
    const raw = await redis.get(_key(sessionId));
    if (!raw) {
      log.debug({ sessionId }, "session get miss");
      return [];
    }
    try {
      const msgs = JSON.parse(raw) as Message[];
      log.debug({ sessionId, msgCount: msgs.length }, "session get hit");
      return msgs;
    } catch {
      return [];
    }
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    const redis = await getRedis();
    const existing = await this.get(sessionId);
    const merged = [...existing, ...messages];
    await redis.set(_key(sessionId), JSON.stringify(merged), { EX: TTL_SECONDS });
    log.debug({ sessionId, addedCount: messages.length, totalCount: merged.length }, "session append");
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    const redis = await getRedis();
    await redis.set(_key(sessionId), JSON.stringify(messages), { EX: TTL_SECONDS });
  }

  async reset(sessionId: string): Promise<void> {
    const redis = await getRedis();
    await redis.del(_key(sessionId));
    log.debug({ sessionId }, "session reset");
  }
}

export const sessionStore = new SessionStore();
