/**
 * TC-AUTH-002/004: JWT 签发、验证与 Refresh Token 工具函数测试
 * 这些函数纯粹依赖加密库，无需 DB / Redis / LLM。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getJwtSecret: vi.fn(() => "super-secret-test-key-32chars!!"),
  getJwtIssuer: vi.fn(() => "edu-platform"),
  getAccessTtlSec: vi.fn(() => 900),
}));

import {
  signAccessToken,
  verifyAccessToken,
  type AccessJwtPayload,
} from "@/lib/jwt";
import {
  generateRefreshTokenPlain,
  hashRefreshToken,
} from "@/lib/refresh-token";
import { UserRole } from "@prisma/client";

describe("JWT 签发与验证", () => {
  const payload: AccessJwtPayload = {
    sub: "user-uuid-001",
    username: "alice",
    role: UserRole.STUDENT,
  };

  it("TC-AUTH-002: signAccessToken 应返回可被 verifyAccessToken 验证的 JWT", async () => {
    const token = await signAccessToken(payload);
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3); // header.payload.sig

    const decoded = await verifyAccessToken(token);
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.username).toBe(payload.username);
    expect(decoded.role).toBe(UserRole.STUDENT);
  });

  it("TC-RBAC-002: 篡改 payload 后 JWT 验证应失败", async () => {
    const token = await signAccessToken(payload);
    // 解构 JWT，伪造 payload（role 从 STUDENT 改为 TEACHER）
    const [header, , signature] = token.split(".");
    const fakeClaims = Buffer.from(
      JSON.stringify({
        sub: payload.sub,
        username: payload.username,
        role: UserRole.TEACHER, // tampered
        iss: "edu-platform",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");
    const tamperedToken = `${header}.${fakeClaims}.${signature}`;

    await expect(verifyAccessToken(tamperedToken)).rejects.toThrow();
  });

  it("TC-AUTH-004: 过期 token 应抛出验证错误", async () => {
    // 使用一个过去时间戳 exp 的 token（手动构造）
    // 最简单方式：将 getAccessTtlSec mock 为 -1s（已过期），重新签发
    const { getAccessTtlSec } = await import("@/lib/config");
    vi.mocked(getAccessTtlSec).mockReturnValueOnce(-10); // 10 秒前已过期

    const expiredToken = await signAccessToken(payload);
    await expect(verifyAccessToken(expiredToken)).rejects.toThrow();
  });

  it("使用错误 secret 签发的 token 应验证失败", async () => {
    const { getJwtSecret } = await import("@/lib/config");
    // 签发时用一个不同的 secret
    vi.mocked(getJwtSecret).mockReturnValueOnce("different-secret-key-32chars!!");
    const wrongToken = await signAccessToken(payload);

    // 验证时恢复原 secret
    await expect(verifyAccessToken(wrongToken)).rejects.toThrow();
  });
});

describe("Refresh Token 工具函数", () => {
  it("generateRefreshTokenPlain 应生成 base64url 格式的不重复字符串", () => {
    const t1 = generateRefreshTokenPlain();
    const t2 = generateRefreshTokenPlain();

    expect(typeof t1).toBe("string");
    expect(t1.length).toBeGreaterThan(40); // 48 bytes → base64url ≥ 64 chars
    expect(t1).not.toBe(t2);
    // base64url 不含 +/= 
    expect(/^[A-Za-z0-9_-]+$/.test(t1)).toBe(true);
  });

  it("hashRefreshToken 应对相同输入产生确定性输出", () => {
    const plain = generateRefreshTokenPlain();
    const h1 = hashRefreshToken(plain);
    const h2 = hashRefreshToken(plain);

    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/); // HMAC-SHA256 hex = 64 chars
  });

  it("hashRefreshToken 不同输入应产生不同摘要", () => {
    const h1 = hashRefreshToken("token-aaa");
    const h2 = hashRefreshToken("token-bbb");
    expect(h1).not.toBe(h2);
  });

  it("hashRefreshToken 原始 token 不能从摘要反推", () => {
    const plain = generateRefreshTokenPlain();
    const hash = hashRefreshToken(plain);
    // 摘要不包含原始 token 内容（基本反向测试）
    expect(hash).not.toContain(plain);
  });
});
