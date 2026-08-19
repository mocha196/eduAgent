/**
 * SessionStore — stores Message[] in Redis.
 * Key: agent:session:{sessionId}  TTL: 24 h
 */

import { getRedis } from "@/lib/redis";
import type { Message } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "session-store" });
const TTL_SECONDS = 24 * 60 * 60;

// Keep the existing JSON representation while making append atomic across
// Node processes. Redis executes Lua scripts as a single operation.
const APPEND_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local messages = {}
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' then messages = decoded end
end
local additions = cjson.decode(ARGV[1])
for i = 1, #additions do
  messages[#messages + 1] = additions[i]
end
redis.call('SET', KEYS[1], cjson.encode(messages), 'EX', ARGV[2])
return #messages
`;

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
    const totalCount = await redis.eval(APPEND_SCRIPT, {
      keys: [_key(sessionId)],
      arguments: [JSON.stringify(messages), String(TTL_SECONDS)],
    });
    log.debug({ sessionId, addedCount: messages.length, totalCount }, "session append");
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
