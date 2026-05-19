/**
 * Integration tests: Redis
 *
 * Tests real Redis operations using the configured REDIS_URL.
 * All keys use an isolated test prefix and are cleaned up after each suite.
 *
 * TC-REDIS-001: Connectivity + PING
 * TC-REDIS-002: RAG task stream XADD / XREAD
 * TC-REDIS-003: Session store SET / GET / DEL with TTL
 */
import { afterAll, describe, expect, it } from "vitest";
import { getRedis } from "@/lib/redis";

const TEST_PREFIX = `it_redis_${Date.now()}`;
const STREAM_KEY = `${TEST_PREFIX}:stream`;
const SESSION_KEY = `${TEST_PREFIX}:session`;

describe("Redis integration", () => {
  afterAll(async () => {
    const redis = await getRedis();
    // Clean up test keys
    const keys = await redis.keys(`${TEST_PREFIX}:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  // ─── TC-REDIS-001: Connectivity ───────────────────────────────────────────

  describe("TC-REDIS-001: connectivity", () => {
    it("PING returns PONG", async () => {
      const redis = await getRedis();
      const result = await redis.ping();
      expect(result).toBe("PONG");
    });

    it("INFO server returns redis_version", async () => {
      const redis = await getRedis();
      const info = await redis.info("server");
      expect(info).toContain("redis_version");
    });
  });

  // ─── TC-REDIS-002: Stream operations (RAG task queue) ────────────────────

  describe("TC-REDIS-002: Redis Stream XADD / XREAD", () => {
    it("XADD writes a message and returns a stream ID", async () => {
      const redis = await getRedis();
      const id = await redis.xAdd(STREAM_KEY, "*", {
        task_id: "test-task-1",
        material_id: "mat-abc",
        operation: "parse_and_index",
        created_at: new Date().toISOString(),
      });
      expect(id).toMatch(/^\d+-\d+$/);
    });

    it("XREAD reads back the message written by XADD", async () => {
      const redis = await getRedis();
      const messages = await redis.xRead([{ key: STREAM_KEY, id: "0" }], {
        COUNT: 10,
      });
      expect(messages).not.toBeNull();
      expect(messages!.length).toBeGreaterThan(0);
      const entries = messages![0]!.messages;
      expect(entries.length).toBeGreaterThan(0);
      const msg = entries[0]!.message;
      expect(msg["task_id"]).toBe("test-task-1");
      expect(msg["material_id"]).toBe("mat-abc");
      expect(msg["operation"]).toBe("parse_and_index");
    });

    it("XLEN returns the correct message count after multiple writes", async () => {
      const redis = await getRedis();
      await redis.xAdd(STREAM_KEY, "*", { task_id: "t2", material_id: "m2", operation: "index_only", created_at: new Date().toISOString() });
      await redis.xAdd(STREAM_KEY, "*", { task_id: "t3", material_id: "m3", operation: "delete_material", created_at: new Date().toISOString() });
      const len = await redis.xLen(STREAM_KEY);
      expect(len).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── TC-REDIS-003: Key / TTL operations (session store) ──────────────────

  describe("TC-REDIS-003: SET / GET / TTL / DEL", () => {
    it("SET stores a value and GET retrieves it", async () => {
      const redis = await getRedis();
      await redis.set(SESSION_KEY, JSON.stringify([{ role: "user", content: "hello" }]));
      const val = await redis.get(SESSION_KEY);
      expect(val).not.toBeNull();
      const parsed = JSON.parse(val!);
      expect(parsed[0].content).toBe("hello");
    });

    it("EXPIRE sets a TTL and TTL returns remaining seconds", async () => {
      const redis = await getRedis();
      await redis.expire(SESSION_KEY, 3600);
      const ttl = await redis.ttl(SESSION_KEY);
      expect(ttl).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);
    });

    it("DEL removes the key", async () => {
      const redis = await getRedis();
      await redis.del(SESSION_KEY);
      const val = await redis.get(SESSION_KEY);
      expect(val).toBeNull();
    });
  });
});
