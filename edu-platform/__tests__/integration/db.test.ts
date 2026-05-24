/**
 * Integration tests: PostgreSQL via Prisma
 *
 * Tests user + refresh-token lifecycle using the real database.
 * All data is inserted with a recognizable test prefix and deleted on cleanup.
 *
 * TC-DB-001: User CRUD + unique-username constraint
 * TC-DB-002: Refresh token create / lookup / revoke cycle
 * TC-AUTH-001: Password hash + verify round-trip via argon2id
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { generateRefreshTokenPlain, hashRefreshToken } from "@/lib/refresh-token";
import { UserRole } from "@prisma/client";

const TEST_PREFIX = `it_db_${Date.now()}`;
const TEST_USER = {
  username: `${TEST_PREFIX}_user`,
  password: "Integration!T3st",
};

let createdUserId: string;

describe("PostgreSQL integration — User & RefreshToken", () => {
  afterAll(async () => {
    // Clean up all test-prefixed users (cascades to refresh_tokens)
    await prisma.user.deleteMany({
      where: { username: { startsWith: TEST_PREFIX } },
    });
    await prisma.$disconnect();
  });

  // ─── TC-AUTH-001: Password hashing ────────────────────────────────────────

  describe("TC-AUTH-001: argon2id password hashing", () => {
    it("hashPassword produces a hash that verifyPassword accepts", async () => {
      const hash = await hashPassword(TEST_USER.password);
      expect(hash).toMatch(/^\$argon2id\$/);
      const ok = await verifyPassword(hash, TEST_USER.password);
      expect(ok).toBe(true);
    });

    it("verifyPassword rejects a wrong password", async () => {
      const hash = await hashPassword(TEST_USER.password);
      const ok = await verifyPassword(hash, "WrongPassword!");
      expect(ok).toBe(false);
    });
  });

  // ─── TC-DB-001: User CRUD ─────────────────────────────────────────────────

  describe("TC-DB-001: User CRUD + unique constraint", () => {
    it("creates a new user record in the database", async () => {
      const passwordHash = await hashPassword(TEST_USER.password);
      const user = await prisma.user.create({
        data: {
          username: TEST_USER.username,
          passwordHash,
          role: UserRole.STUDENT,
        },
      });
      createdUserId = user.id;
      expect(user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(user.username).toBe(TEST_USER.username);
      expect(user.role).toBe(UserRole.STUDENT);
      expect(user.isActive).toBe(true);
    });

    it("findUnique returns the created user by username", async () => {
      const user = await prisma.user.findUnique({
        where: { username: TEST_USER.username },
      });
      expect(user).not.toBeNull();
      expect(user!.id).toBe(createdUserId);
    });

    it("duplicate username raises a unique constraint violation", async () => {
      const passwordHash = await hashPassword("AnotherPass!1");
      await expect(
        prisma.user.create({
          data: {
            username: TEST_USER.username, // same username — must fail
            passwordHash,
            role: UserRole.STUDENT,
          },
        }),
      ).rejects.toThrow();
    });

    it("update sets isActive=false (soft disable)", async () => {
      const updated = await prisma.user.update({
        where: { id: createdUserId },
        data: { isActive: false },
      });
      expect(updated.isActive).toBe(false);
      // restore
      await prisma.user.update({
        where: { id: createdUserId },
        data: { isActive: true },
      });
    });
  });

  // ─── TC-DB-002: Refresh token lifecycle ───────────────────────────────────

  describe("TC-DB-002: Refresh token create / lookup / revoke", () => {
    let tokenPlain: string;
    let tokenHash: string;
    let tokenId: string;

    beforeAll(async () => {
      tokenPlain = generateRefreshTokenPlain();
      tokenHash = hashRefreshToken(tokenPlain);
    });

    it("inserts a refresh token row linked to the user", async () => {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const row = await prisma.refreshToken.create({
        data: {
          userId: createdUserId,
          tokenHash,
          expiresAt,
        },
      });
      tokenId = row.id;
      expect(row.revokedAt).toBeNull();
      expect(row.userId).toBe(createdUserId);
    });

    it("lookup by tokenHash returns the matching row", async () => {
      const row = await prisma.refreshToken.findFirst({
        where: { tokenHash, revokedAt: null },
      });
      expect(row).not.toBeNull();
      expect(row!.id).toBe(tokenId);
    });

    it("revokes the token by setting revokedAt", async () => {
      await prisma.refreshToken.update({
        where: { id: tokenId },
        data: { revokedAt: new Date() },
      });
      const row = await prisma.refreshToken.findFirst({
        where: { tokenHash, revokedAt: null },
      });
      expect(row).toBeNull(); // should not be found anymore
    });

    it("cascade delete removes tokens when user is deleted", async () => {
      // Create a second throwaway user and its token
      const hash2 = await hashPassword("Throwaway!1");
      const tmp = await prisma.user.create({
        data: {
          username: `${TEST_PREFIX}_tmp`,
          passwordHash: hash2,
          role: UserRole.STUDENT,
        },
      });
      const plain2 = generateRefreshTokenPlain();
      await prisma.refreshToken.create({
        data: {
          userId: tmp.id,
          tokenHash: hashRefreshToken(plain2),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      // Delete user — tokens should cascade
      await prisma.user.delete({ where: { id: tmp.id } });
      const remaining = await prisma.refreshToken.findFirst({
        where: { userId: tmp.id },
      });
      expect(remaining).toBeNull();
    });
  });
});
