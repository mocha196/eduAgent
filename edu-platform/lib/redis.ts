import { createClient, type RedisClientType } from "redis";
import { getRedisUrl } from "@/lib/config";

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
        console.error("[redis] client error", err);
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
