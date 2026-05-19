/**
 * Unit tests for lib/agent/llm-registry.ts — getRoleConfig fallback chains.
 *
 * getUserLlmStore is partially mocked so we can inject per-user overrides
 * without touching the filesystem or AsyncLocalStorage.
 *
 * TC-REG-001: chat — no user override → uses LLM_CHAT_API_KEY from env
 * TC-REG-002: chat — user override apiKey wins over env var
 * TC-REG-003: chat — partial user override (model only) → apiKey still from env
 * TC-REG-004: title — multi-level fallback: LLM_TITLE_API_KEY → LLM_CHAT_API_KEY → LLM_API_KEY
 * TC-REG-005: memory — LLM_AUXILIARY_MODEL used when LLM_MODEL not set
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the mock so it can be referenced inside vi.mock factory
const { getUserLlmStoreMock } = vi.hoisted(() => ({
  getUserLlmStoreMock: vi.fn(),
}));

// Partially replace user-llm-store: keep all real exports except getUserLlmStore
vi.mock("@/lib/agent/user-llm-store", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/agent/user-llm-store")>();
  return {
    ...mod,
    getUserLlmStore: getUserLlmStoreMock,
  };
});

import { getRoleConfig } from "@/lib/agent/llm-registry";

// Env vars touched by these tests
const ENV_KEYS = [
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "LLM_CHAT_API_KEY",
  "LLM_CHAT_BASE_URL",
  "LLM_CHAT_MODEL",
  "LLM_TITLE_API_KEY",
  "LLM_TITLE_BASE_URL",
  "LLM_TITLE_MODEL",
  "LLM_VISION_API_KEY",
  "LLM_AUXILIARY_MODEL",
  "LLM_MODEL",
  "LLM_BASE_URL",
] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("getRoleConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserLlmStoreMock.mockReturnValue(undefined); // default: no user override
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("TC-REG-001: chat — no user override, falls back to LLM_CHAT_API_KEY + LLM_CHAT_MODEL", () => {
    process.env.LLM_CHAT_API_KEY = "env-chat-key";
    process.env.LLM_CHAT_MODEL = "deepseek-v4";
    const cfg = getRoleConfig("chat");
    expect(cfg.apiKey).toBe("env-chat-key");
    expect(cfg.model).toBe("deepseek-v4");
  });

  it("TC-REG-002: chat — user apiKey + model override wins over env vars", () => {
    process.env.LLM_CHAT_API_KEY = "env-chat-key";
    process.env.LLM_CHAT_MODEL = "env-model";
    getUserLlmStoreMock.mockReturnValue({
      chat: { apiKey: "user-override-key", model: "my-model" },
    });
    const cfg = getRoleConfig("chat");
    expect(cfg.apiKey).toBe("user-override-key");
    expect(cfg.model).toBe("my-model");
  });

  it("TC-REG-003: chat — partial override (model only) → apiKey still from env", () => {
    process.env.LLM_CHAT_API_KEY = "env-chat-key";
    getUserLlmStoreMock.mockReturnValue({
      chat: { model: "user-preferred-model" },
    });
    const cfg = getRoleConfig("chat");
    expect(cfg.apiKey).toBe("env-chat-key");
    expect(cfg.model).toBe("user-preferred-model");
  });

  it("TC-REG-004: title — LLM_TITLE_API_KEY > LLM_CHAT_API_KEY > LLM_API_KEY fallback chain", () => {
    // Tier 1: only LLM_API_KEY
    process.env.LLM_API_KEY = "default-key";
    expect(getRoleConfig("title").apiKey).toBe("default-key");

    // Tier 2: LLM_CHAT_API_KEY overrides LLM_API_KEY
    process.env.LLM_CHAT_API_KEY = "chat-key";
    expect(getRoleConfig("title").apiKey).toBe("chat-key");

    // Tier 3: LLM_TITLE_API_KEY overrides both
    process.env.LLM_TITLE_API_KEY = "title-key";
    expect(getRoleConfig("title").apiKey).toBe("title-key");
  });

  it("TC-REG-005: memory — uses LLM_AUXILIARY_MODEL when LLM_MODEL not set", () => {
    process.env.LLM_AUXILIARY_MODEL = "qwen-plus";
    process.env.LLM_API_KEY = "mem-key";
    const cfg = getRoleConfig("memory");
    expect(cfg.model).toBe("qwen-plus");
    expect(cfg.apiKey).toBe("mem-key");
  });
});
