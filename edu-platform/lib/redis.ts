import { createClient, type RedisClientType } from "redis";
import { getRedisUrl } from "@/lib/config";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "redis" });

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType> | null = null;
let hasLoggedRedisError = false;

export function isRedisConfigured(): boolean {
  return Boolean(getRedisUrl());
}

export async function getRedis(): Promise<RedisClientType> {
  const url = getRedisUrl();
  if (!url) {
    throw new Error("REDIS_URL is not configured");
  }
  if (client?.isOpen) {
    return client;
  }
  if (connectPromise) {
    return connectPromise;
  }
  connectPromise = (async () => {
    const c = createClient({ url });
    c.on("error", (err) => {
      if (!hasLoggedRedisError) {
        hasLoggedRedisError = true;
        log.error({ err }, "Redis client error");
      }
    });
    await c.connect();
    hasLoggedRedisError = false;
    client = c as RedisClientType;
    return client;
  })();
  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}
