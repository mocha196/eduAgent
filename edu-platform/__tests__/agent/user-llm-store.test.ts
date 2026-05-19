/**
 * Unit tests for lib/agent/user-llm-store.ts — pure functions only.
 *
 * File I/O, caching, and ALS functions are covered by integration tests.
 *
 * TC-ULS-001: AES-256-GCM encrypt / decrypt round-trip
 * TC-ULS-002: Encrypt uniqueness (random IV)
 * TC-ULS-003: Tampered ciphertext → empty string
 * TC-ULS-004: No encryption key → plaintext passthrough
 * TC-ULS-005: No encryption key + enc: prefix → empty string
 * TC-ULS-006: Non-enc: prefix value is returned unchanged
 * TC-ULS-007: maskApiKey — empty input
 * TC-ULS-008: maskApiKey — short key (≤ 4 chars)
 * TC-ULS-009: maskApiKey — long key
 * TC-ULS-010: isUnmodifiedMask — true for length ≥ 5 ending with ****
 * TC-ULS-011: isUnmodifiedMask — false for short or non-**** suffix
 * TC-ULS-012: maskConfig — all roles, masked keys, empty defaults
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_ROLES,
  decryptApiKey,
  encryptApiKey,
  isUnmodifiedMask,
  maskApiKey,
  maskConfig,
} from "@/lib/agent/user-llm-store";

// 32-byte key expressed as 64 hex characters
const TEST_KEY_HEX =
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

describe("user-llm-store — pure functions", () => {
  // ─── TC-ULS-001 to TC-ULS-003: encrypt / decrypt WITH key ────────────────

  describe("encryptApiKey / decryptApiKey — with encryption key", () => {
    beforeEach(() => {
      process.env.LLM_CONFIG_ENCRYPTION_KEY = TEST_KEY_HEX;
    });
    afterEach(() => {
      delete process.env.LLM_CONFIG_ENCRYPTION_KEY;
    });

    it("TC-ULS-001: encrypts and decrypts a key round-trip", () => {
      const plain = "sk-mysecretapikey-12345";
      const enc = encryptApiKey(plain);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain(plain);
      expect(decryptApiKey(enc)).toBe(plain);
    });

    it("TC-ULS-002: produces unique ciphertext on repeated calls (random IV)", () => {
      const plain = "sk-samekey";
      const enc1 = encryptApiKey(plain);
      const enc2 = encryptApiKey(plain);
      expect(enc1).not.toBe(enc2);
      expect(decryptApiKey(enc1)).toBe(plain);
      expect(decryptApiKey(enc2)).toBe(plain);
    });

    it("TC-ULS-003: returns empty string for tampered ciphertext", () => {
      const enc = encryptApiKey("sk-original");
      const tampered = enc.slice(0, -4) + "XXXX";
      expect(decryptApiKey(tampered)).toBe("");
    });
  });

  // ─── TC-ULS-004 to TC-ULS-006: encrypt / decrypt WITHOUT key ─────────────

  describe("encryptApiKey / decryptApiKey — without encryption key", () => {
    beforeEach(() => {
      delete process.env.LLM_CONFIG_ENCRYPTION_KEY;
    });

    it("TC-ULS-004: encryptApiKey returns plaintext unchanged when key not configured", () => {
      expect(encryptApiKey("sk-nokey")).toBe("sk-nokey");
    });

    it("TC-ULS-005: decryptApiKey returns '' for enc:-prefixed value when key not configured", () => {
      expect(decryptApiKey("enc:aGVsbG8=")).toBe("");
    });

    it("TC-ULS-006: decryptApiKey returns value unchanged for non-enc:-prefixed string", () => {
      expect(decryptApiKey("sk-plain")).toBe("sk-plain");
    });
  });

  // ─── TC-ULS-007 to TC-ULS-009: maskApiKey ────────────────────────────────

  describe("maskApiKey", () => {
    it("TC-ULS-007: returns empty string for empty input", () => {
      expect(maskApiKey("")).toBe("");
    });

    it("TC-ULS-008: returns **** for keys with 4 or fewer characters", () => {
      expect(maskApiKey("abcd")).toBe("****");
      expect(maskApiKey("ab")).toBe("****");
    });

    it("TC-ULS-009: masks to first 4 chars + **** for longer keys", () => {
      expect(maskApiKey("sk-mysecret")).toBe("sk-m****");
      expect(maskApiKey("12345678")).toBe("1234****");
    });
  });

  // ─── TC-ULS-010 to TC-ULS-011: isUnmodifiedMask ──────────────────────────

  describe("isUnmodifiedMask", () => {
    it("TC-ULS-010: returns true for strings of length >= 5 ending with ****", () => {
      expect(isUnmodifiedMask("sk-1****")).toBe(true);
      expect(isUnmodifiedMask("a****")).toBe(true);
    });

    it("TC-ULS-011: returns false for strings shorter than 5 chars or not ending with ****", () => {
      expect(isUnmodifiedMask("****")).toBe(false); // length 4, below threshold
      expect(isUnmodifiedMask("sk-1***")).toBe(false);
      expect(isUnmodifiedMask("sk-123")).toBe(false);
      expect(isUnmodifiedMask("")).toBe(false);
    });
  });

  // ─── TC-ULS-012: maskConfig ───────────────────────────────────────────────

  describe("maskConfig", () => {
    it("TC-ULS-012: returns all 5 roles with masked apiKey and empty defaults for unset fields", () => {
      const config = {
        chat: { apiKey: "sk-longapikey", model: "gpt-4o" },
        title: { apiKey: "sk-12345", baseURL: "https://api.example.com" },
      };
      const masked = maskConfig(config);

      // All 5 roles must be present
      expect(Object.keys(masked)).toEqual(expect.arrayContaining([...ALL_ROLES]));
      expect(Object.keys(masked)).toHaveLength(5);

      // chat: apiKey masked, model preserved, baseURL defaults to ""
      expect(masked.chat.apiKey).toBe("sk-l****");
      expect(masked.chat.model).toBe("gpt-4o");
      expect(masked.chat.baseURL).toBe("");

      // title: apiKey masked, baseURL preserved, model defaults to ""
      expect(masked.title.apiKey).toBe("sk-1****");
      expect(masked.title.baseURL).toBe("https://api.example.com");
      expect(masked.title.model).toBe("");

      // unset roles — all fields default to ""
      expect(masked.vision.apiKey).toBe("");
      expect(masked.memory.model).toBe("");
      expect(masked.grading.baseURL).toBe("");
    });
  });
});
