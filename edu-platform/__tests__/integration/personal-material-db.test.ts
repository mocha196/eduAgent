/**
 * Integration tests: PersonalMaterial model via Prisma + PostgreSQL
 *
 * Prerequisites: docker compose up -d (postgres must be running)
 * DATABASE_URL: postgresql://edu:edu@localhost:5432/edu_platform?schema=public
 *
 * TC-PKB-001: create PersonalMaterial row — returns UUID id, correct defaults
 * TC-PKB-002: findFirst by id + userId — returns the created row
 * TC-PKB-003: update status to PARSED + indexedChunkCount to 42 — confirmed
 * TC-PKB-004: soft delete — findFirst with isDeleted:false returns null
 * TC-PKB-005: deleteMany on isDeleted:true — does not affect active rows
 */
import { randomUUID } from "node:crypto";
import { MaterialPreviewPdfStatus, MaterialStatus, UserRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

const PREFIX = `it_pkb_${Date.now()}`;
const TEST_EMAIL = `${PREFIX}@test.local`;

let userId: string;
let materialId: string;

describe("PersonalMaterial — PostgreSQL integration", () => {
  beforeAll(async () => {
    // Create a dedicated test user; PersonalMaterial rows cascade-delete with user
    const user = await prisma.user.create({
      data: {
        username: `${PREFIX}_user`,
        email: TEST_EMAIL,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder",
        role: UserRole.STUDENT,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // Remove all test data; cascade deletes the personal_materials rows as well
    await prisma.user.deleteMany({ where: { email: { endsWith: "@test.local" } } });
    await prisma.$disconnect();
  });

  // ─── TC-PKB-001 ───────────────────────────────────────────────────────────

  it("TC-PKB-001: creates a PersonalMaterial row and returns a UUID id", async () => {
    materialId = randomUUID();
    const mat = await prisma.personalMaterial.create({
      data: {
        id: materialId,
        userId,
        originalFilename: "lecture.pdf",
        fileType: "pdf",
        fileSize: 2048,
        minioPath: `personal_materials/${userId}/${materialId}/lecture.pdf`,
        status: MaterialStatus.UPLOADED,
      },
    });

    expect(mat.id).toBe(materialId);
    expect(mat.status).toBe(MaterialStatus.UPLOADED);
    expect(mat.previewPdfStatus).toBe(MaterialPreviewPdfStatus.NA);
    expect(mat.isDeleted).toBe(false);
    expect(mat.indexedChunkCount).toBe(0);
    expect(mat.transcriptText).toBeNull();
  });

  // ─── TC-PKB-002 ───────────────────────────────────────────────────────────

  it("TC-PKB-002: findFirst by id + userId returns the created row", async () => {
    const found = await prisma.personalMaterial.findFirst({
      where: { id: materialId, userId, isDeleted: false },
    });
    expect(found).not.toBeNull();
    expect(found!.originalFilename).toBe("lecture.pdf");
    expect(found!.fileType).toBe("pdf");
    expect(found!.fileSize).toBe(2048);
  });

  // ─── TC-PKB-003 ───────────────────────────────────────────────────────────

  it("TC-PKB-003: update status to PARSED and indexedChunkCount to 42", async () => {
    const updated = await prisma.personalMaterial.update({
      where: { id: materialId },
      data: { status: MaterialStatus.PARSED, indexedChunkCount: 42 },
    });
    expect(updated.status).toBe(MaterialStatus.PARSED);
    expect(updated.indexedChunkCount).toBe(42);
  });

  // ─── TC-PKB-004 ───────────────────────────────────────────────────────────

  it("TC-PKB-004: soft delete — findFirst with isDeleted:false returns null", async () => {
    await prisma.personalMaterial.update({
      where: { id: materialId },
      data: { isDeleted: true },
    });
    const found = await prisma.personalMaterial.findFirst({
      where: { id: materialId, isDeleted: false },
    });
    expect(found).toBeNull();
  });

  // ─── TC-PKB-005 ───────────────────────────────────────────────────────────

  it("TC-PKB-005: deleteMany on isDeleted:true rows does not affect active rows", async () => {
    // Create a fresh active material
    const activeId = randomUUID();
    await prisma.personalMaterial.create({
      data: {
        id: activeId,
        userId,
        originalFilename: "active.pdf",
        fileType: "pdf",
        fileSize: 512,
        minioPath: `personal_materials/${userId}/${activeId}/active.pdf`,
        status: MaterialStatus.UPLOADED,
      },
    });

    // Delete only the soft-deleted rows for this user
    const { count } = await prisma.personalMaterial.deleteMany({
      where: { userId, isDeleted: true },
    });
    expect(count).toBeGreaterThanOrEqual(1);

    // Active row must still be present
    const active = await prisma.personalMaterial.findFirst({
      where: { id: activeId, isDeleted: false },
    });
    expect(active).not.toBeNull();
  });
});
