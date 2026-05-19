/**
 * Per-user LLM configuration store.
 *
 * Stores API key / base URL / model overrides for each LLM role in a
 * server-side JSON file:  data/llm-config/{userId}.json
 *
 * Security:
 *   - API keys are encrypted at rest with AES-256-GCM using
 *     LLM_CONFIG_ENCRYPTION_KEY (32-byte hex in .env).
 *   - The GET API never returns plaintext keys — only a masked version.
 *   - userId is validated as UUID before being used as filename.
 *
 * Injection:
 *   - AsyncLocalStorage propagates the config through the entire
 *     async call chain (ReAct loop, tools, vision pre-process, title
 *     generation, grading) without touching every function signature.
 */

import { AsyncLocalStorage } from "async_hooks";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";

// ---- Types -----------------------------------------------------------------

// Local aliases to avoid circular imports with llm-registry.ts
export type LLMRoleKey = "chat" | "vision" | "title" | "memory" | "grading";
export type UserRoleOverride = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
};
export type UserLlmConfig = Partial<Record<LLMRoleKey, UserRoleOverride>>;

// What gets stored in the JSON file (apiKey may be encrypted)
type StoredRoleConfig = { apiKey?: string; baseURL?: string; model?: string };
type StoredConfig = Partial<Record<LLMRoleKey, StoredRoleConfig>>;

export const ALL_ROLES: LLMRoleKey[] = ["chat", "vision", "title", "memory", "grading"];

// ---- AsyncLocalStorage -----------------------------------------------------

const _als = new AsyncLocalStorage<UserLlmConfig>();

/** Returns the user LLM config bound to the current async context, or undefined. */
export function getUserLlmStore(): UserLlmConfig | undefined {
  return _als.getStore();
}

// ---- AES-256-GCM encryption ------------------------------------------------

const ALG = "aes-256-gcm" as const;
const IV_LEN = 12;
const TAG_LEN = 16;
const ENC_PREFIX = "enc:";

function getEncKey(): Buffer | null {
  const k = process.env.LLM_CONFIG_ENCRYPTION_KEY?.trim();
  if (!k) return null;
  try {
    const buf = Buffer.from(k, "hex");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Encrypts an API key with AES-256-GCM.
 * Returns plaintext unchanged if LLM_CONFIG_ENCRYPTION_KEY is not set.
 */
export function encryptApiKey(plain: string): string {
  if (!plain) return plain;
  const key = getEncKey();
  if (!key) return plain; // no encryption key configured — store as-is
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: "enc:" + base64(iv || tag || ciphertext)
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypts a key that was encrypted with encryptApiKey.
 * Returns plaintext unchanged if it doesn't start with "enc:".
 * Returns empty string if decryption fails (key changed / corrupted).
 */
export function decryptApiKey(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const key = getEncKey();
  if (!key) return ""; // encryption key not configured — cannot decrypt
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
    if (buf.length < IV_LEN + TAG_LEN + 1) return "";
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
  } catch {
    return ""; // decryption failed (wrong key, corrupted data)
  }
}

/** Returns a masked version for display: first 4 chars + "****". */
export function maskApiKey(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 4) return "****";
  return plain.slice(0, 4) + "****";
}

/** Returns true if the value looks like an unmodified masked key (e.g. "sk-4****"). */
export function isUnmodifiedMask(value: string): boolean {
  return value.length >= 5 && value.endsWith("****");
}

// ---- File I/O --------------------------------------------------------------

function configDir(): string {
  return path.join(process.cwd(), "data", "llm-config");
}

/** Validates and returns the config file path for a user. */
function configPath(userId: string): string {
  // Accept standard UUID or UUID without hyphens — reject anything else
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`Invalid userId for LLM config path: "${userId}"`);
  }
  return path.join(configDir(), `${userId}.json`);
}

// ---- In-memory cache (simple TTL map) -------------------------------------

type CacheEntry = { config: UserLlmConfig; expiresAt: number };
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

function cacheGet(userId: string): UserLlmConfig | undefined {
  const entry = _cache.get(userId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(userId);
    return undefined;
  }
  return entry.config;
}

function cacheSet(userId: string, config: UserLlmConfig): void {
  if (_cache.size >= CACHE_MAX) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  _cache.set(userId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidateUserLlmCache(userId: string): void {
  _cache.delete(userId);
}

// ---- Load / save -----------------------------------------------------------

/** Reads user config from disk, decrypts keys, and caches the result. */
export async function loadUserLlmConfig(userId: string): Promise<UserLlmConfig> {
  const cached = cacheGet(userId);
  if (cached !== undefined) return cached;

  let stored: StoredConfig;
  try {
    const text = await fs.readFile(configPath(userId), "utf-8");
    stored = JSON.parse(text) as StoredConfig;
  } catch {
    // File not found or parse error — treat as empty config
    const empty: UserLlmConfig = {};
    cacheSet(userId, empty);
    return empty;
  }

  const config: UserLlmConfig = {};
  for (const role of ALL_ROLES) {
    const rc = stored[role];
    if (!rc || typeof rc !== "object") continue;
    const apiKey = rc.apiKey ? decryptApiKey(rc.apiKey) : undefined;
    config[role] = {
      apiKey: apiKey || undefined,
      baseURL: rc.baseURL?.trim() || undefined,
      model: rc.model?.trim() || undefined,
    };
  }

  cacheSet(userId, config);
  return config;
}

/**
 * Saves user LLM config to disk.
 *
 * apiKey handling per role:
 *   - empty string / undefined  →  clear (will inherit from .env)
 *   - ends with "****"          →  unmodified mask from GET — preserve existing
 *   - anything else             →  new key, encrypt and save
 */
export async function saveUserLlmConfig(
  userId: string,
  incoming: UserLlmConfig,
): Promise<void> {
  // Load existing decrypted config to handle "unchanged" masks
  const existing = await loadUserLlmConfig(userId).catch(() => ({} as UserLlmConfig));

  const stored: StoredConfig = {};

  for (const role of ALL_ROLES) {
    const inc = incoming[role] ?? {};
    const ex = existing[role] ?? {};

    // Resolve apiKey
    let encryptedKey: string | undefined;
    const incKey = (inc.apiKey ?? "").trim();
    if (incKey === "") {
      encryptedKey = undefined; // explicitly cleared — inherit from .env
    } else if (isUnmodifiedMask(incKey)) {
      // User didn't edit — preserve existing encrypted value
      // Re-encrypt from existing plaintext (already decrypted by loadUserLlmConfig)
      encryptedKey = ex.apiKey ? encryptApiKey(ex.apiKey) : undefined;
    } else {
      encryptedKey = encryptApiKey(incKey);
    }

    const baseURL = inc.baseURL?.trim() || undefined;
    const model = inc.model?.trim() || undefined;

    if (encryptedKey !== undefined || baseURL !== undefined || model !== undefined) {
      stored[role] = {
        ...(encryptedKey !== undefined ? { apiKey: encryptedKey } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    }
  }

  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(userId), JSON.stringify(stored, null, 2), "utf-8");
  invalidateUserLlmCache(userId);
}

/**
 * Returns a masked version of the config safe for sending to the client.
 * API keys are truncated to first 4 chars + "****".
 */
export function maskConfig(
  config: UserLlmConfig,
): Record<LLMRoleKey, { apiKey: string; baseURL: string; model: string }> {
  const out = {} as Record<LLMRoleKey, { apiKey: string; baseURL: string; model: string }>;
  for (const role of ALL_ROLES) {
    const rc = config[role] ?? {};
    out[role] = {
      apiKey: rc.apiKey ? maskApiKey(rc.apiKey) : "",
      baseURL: rc.baseURL ?? "",
      model: rc.model ?? "",
    };
  }
  return out;
}

// ---- ALS runner ------------------------------------------------------------

/**
 * Loads the user's LLM config from disk and runs `fn` within an
 * AsyncLocalStorage context that provides the config to getRoleConfig().
 *
 * The ALS context propagates through all Promises/awaits in the call tree,
 * including the ReAct loop fire-and-forget Promise inside createReActStream().
 */
export async function runWithUserLlm<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const config = await loadUserLlmConfig(userId);
  return _als.run(config, fn);
}
