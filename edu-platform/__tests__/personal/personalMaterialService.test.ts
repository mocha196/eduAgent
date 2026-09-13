/**
 * Unit tests for lib/services/personalMaterialService.ts
 *
 * All external I/O (Prisma, MinIO, Redis queue, config) is mocked.
 * Pure helpers (isOfficeMaterialFileType, previewPdfObjectKey) are NOT mocked.
 *
 * TC-PSVC-001: listPersonalMaterials — empty list
 * TC-PSVC-002: listPersonalMaterials — maps Prisma rows to summary DTOs
 * TC-PSVC-003: listPersonalMaterials — reconciles stale PARSING material to FAILED
 * TC-PSVC-004: uploadPersonalMaterialStream — 503 when MinIO not configured
 * TC-PSVC-005: uploadPersonalMaterialStream — 400 when file exceeds size limit
 * TC-PSVC-006: uploadPersonalMaterialStream — 400 for unsupported extension
 * TC-PSVC-007: uploadPersonalMaterialStream — pdf success: putObjectStream + create + enqueue
 * TC-PSVC-008: uploadPersonalMaterialStream — pptx enqueues personal_convert_preview
 * TC-PSVC-009: getPersonalMaterial — 404 when material not found
 * TC-PSVC-010: deletePersonalMaterial — soft delete + enqueue personal_delete_material + deleteObject
 */
import { Readable } from "node:stream";
import { MaterialPreviewPdfStatus, MaterialStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoist all mock functions ─────────────────────────────────────────────────

const {
  findManyMock,
  findFirstMock,
  createMock,
  updateManyMock,
  updateMock,
  putObjectStreamMock,
  deleteObjectMock,
  enqueueRagTaskMock,
  assertUuidMock,
  getMinioConfigMock,
  getMaterialMaxUploadBytesMock,
  getRedisUrlMock,
  getMaterialStaleSecMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateManyMock: vi.fn(),
  updateMock: vi.fn(),
  putObjectStreamMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  enqueueRagTaskMock: vi.fn(),
  assertUuidMock: vi.fn(),
  getMinioConfigMock: vi.fn(),
  getMaterialMaxUploadBytesMock: vi.fn(),
  getRedisUrlMock: vi.fn(),
  getMaterialStaleSecMock: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  prisma: {
    personalMaterial: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      create: createMock,
      updateMany: updateManyMock,
      update: updateMock,
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getMinioConfig: getMinioConfigMock,
  getMaterialMaxUploadBytes: getMaterialMaxUploadBytesMock,
  getRedisUrl: getRedisUrlMock,
  getMaterialStaleSec: getMaterialStaleSecMock,
}));

vi.mock("@/lib/minio", () => ({
  putObjectStream: putObjectStreamMock,
  deleteObject: deleteObjectMock,
  getObjectStream: vi.fn(),
}));

vi.mock("@/lib/queue/ragTask", () => ({
  enqueueRagTask: enqueueRagTaskMock,
}));

vi.mock("@/lib/course-access", () => ({
  assertUuid: assertUuidMock,
}));

// ─── Lazy import (after mocks are set up) ─────────────────────────────────────

import {
  deletePersonalMaterial,
  getPersonalMaterial,
  listPersonalMaterials,
  uploadPersonalMaterialStream,
} from "@/lib/services/personalMaterialService";

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_MATERIAL = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  userId: "bbbbbbbb-0000-4000-8000-000000000001",
  originalFilename: "lecture.pdf",
  fileType: "pdf",
  fileSize: 1024,
  minioPath:
    "personal_materials/bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/lecture.pdf",
  previewPdfStatus: MaterialPreviewPdfStatus.NA,
  status: MaterialStatus.UPLOADED,
  statusMessage: null,
  indexedChunkCount: 0,
  transcriptText: null,
  videoSummary: null,
  createdAt: new Date("2026-05-18T00:00:00.000Z"),
  updatedAt: new Date("2026-05-18T00:00:00.000Z"),
  isDeleted: false,
};

describe("personalMaterialService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults — individual tests can override
    getMinioConfigMock.mockReturnValue({ endpoint: "http://localhost:9000" });
    getMaterialMaxUploadBytesMock.mockReturnValue(100 * 1024 * 1024); // 100 MB
    getRedisUrlMock.mockReturnValue("redis://localhost:6379");
    getMaterialStaleSecMock.mockReturnValue(1800); // 30 min
    putObjectStreamMock.mockResolvedValue(undefined);
    deleteObjectMock.mockResolvedValue(undefined);
    enqueueRagTaskMock.mockResolvedValue(undefined);
    assertUuidMock.mockReturnValue(undefined);
  });

  // ─── listPersonalMaterials ────────────────────────────────────────────────

  describe("listPersonalMaterials", () => {
    it("TC-PSVC-001: returns empty materials list when no rows exist", async () => {
      findManyMock.mockResolvedValue([]);
      const result = await listPersonalMaterials(BASE_MATERIAL.userId);
      expect(result).toEqual({ materials: [] });
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: BASE_MATERIAL.userId, isDeleted: false } }),
      );
    });

    it("TC-PSVC-002: maps Prisma rows to PersonalMaterialSummaryDto correctly", async () => {
      findManyMock.mockResolvedValue([BASE_MATERIAL]);
      const result = await listPersonalMaterials(BASE_MATERIAL.userId);
      expect(result.materials).toHaveLength(1);
      const dto = result.materials[0];
      expect(dto.id).toBe(BASE_MATERIAL.id);
      expect(dto.filename).toBe("lecture.pdf");
      expect(dto.file_type).toBe("pdf");
      expect(dto.status).toBe(MaterialStatus.UPLOADED);
      expect(dto.preview_pdf_status).toBe(MaterialPreviewPdfStatus.NA);
      expect(dto.indexed_chunk_count).toBe(0);
      expect(dto.created_at).toBe("2026-05-18T00:00:00.000Z");
    });

    it("TC-PSVC-003: reconciles stale PARSING material to FAILED status", async () => {
      const staleMaterial = {
        ...BASE_MATERIAL,
        status: MaterialStatus.PARSING,
        updatedAt: new Date(0), // epoch — always older than any stale threshold
      };
      const failedMaterial = {
        ...staleMaterial,
        status: MaterialStatus.FAILED,
        statusMessage: "WORKER_ABANDONED: worker was likely interrupted or crashed",
      };

      getMaterialStaleSecMock.mockReturnValue(0); // 0 sec → everything is stale
      findManyMock.mockResolvedValue([staleMaterial]);
      updateManyMock.mockResolvedValue({ count: 1 });
      findFirstMock.mockResolvedValue(failedMaterial);

      const result = await listPersonalMaterials(BASE_MATERIAL.userId);

      expect(updateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MaterialStatus.FAILED }),
        }),
      );
      expect(result.materials[0].status).toBe(MaterialStatus.FAILED);
    });
  });

  // ─── uploadPersonalMaterialStream ─────────────────────────────────────────

  describe("uploadPersonalMaterialStream", () => {
    const baseUploadParams = {
      userId: BASE_MATERIAL.userId,
      originalFilename: "lecture.pdf",
      contentType: "application/pdf",
      contentLength: 512,
      body: Readable.from(["pdf-content"]),
    };

    it("TC-PSVC-004: throws 503 when MinIO is not configured", async () => {
      getMinioConfigMock.mockImplementation(() => {
        throw new Error("MinIO not configured");
      });
      await expect(uploadPersonalMaterialStream(baseUploadParams)).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });
    });

    it("TC-PSVC-005: throws 400 when file exceeds the maximum upload size", async () => {
      getMaterialMaxUploadBytesMock.mockReturnValue(100); // 100 bytes max
      await expect(
        uploadPersonalMaterialStream({ ...baseUploadParams, contentLength: 999 }),
      ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    });

    it("TC-PSVC-006: throws 400 for unsupported file extension", async () => {
      await expect(
        uploadPersonalMaterialStream({
          ...baseUploadParams,
          originalFilename: "malware.exe",
        }),
      ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    });

    it("TC-PSVC-007: pdf upload calls putObjectStream, creates DB record, enqueues parse task", async () => {
      createMock.mockResolvedValue({
        ...BASE_MATERIAL,
        createdAt: new Date("2026-05-18T00:00:00.000Z"),
      });

      const result = await uploadPersonalMaterialStream(baseUploadParams);

      expect(putObjectStreamMock).toHaveBeenCalledOnce();
      expect(createMock).toHaveBeenCalledOnce();
      const objectKey = putObjectStreamMock.mock.calls[0][0].objectKey as string;
      expect(objectKey).toMatch(new RegExp(`^personal_materials/${BASE_MATERIAL.userId}/[^/]+/lecture\\.pdf$`));
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: BASE_MATERIAL.userId,
          minioPath: objectKey,
          previewPdfStatus: MaterialPreviewPdfStatus.NA,
          status: MaterialStatus.UPLOADED,
        }),
      });
      expect(enqueueRagTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "personal_parse_and_index" }),
      );
      expect(result.status).toBe(MaterialStatus.UPLOADED);
      expect(result.original_filename).toBe("lecture.pdf");
    });

    it("TC-PSVC-008: pptx upload enqueues personal_convert_preview operation", async () => {
      createMock.mockResolvedValue({
        ...BASE_MATERIAL,
        originalFilename: "slides.pptx",
        fileType: "pptx",
        previewPdfStatus: MaterialPreviewPdfStatus.PENDING,
        createdAt: new Date("2026-05-18T00:00:00.000Z"),
      });

      await uploadPersonalMaterialStream({
        ...baseUploadParams,
        originalFilename: "slides.pptx",
        contentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });

      expect(enqueueRagTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "personal_convert_preview" }),
      );
    });

    it("does not create a personal record when object storage fails", async () => {
      putObjectStreamMock.mockRejectedValue(new Error("MinIO unavailable"));

      await expect(uploadPersonalMaterialStream(baseUploadParams)).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });

      expect(createMock).not.toHaveBeenCalled();
      expect(enqueueRagTaskMock).not.toHaveBeenCalled();
    });

    it("cleans up the personal object when DB creation fails", async () => {
      createMock.mockRejectedValue(new Error("DB unavailable"));

      await expect(uploadPersonalMaterialStream(baseUploadParams)).rejects.toMatchObject({
        status: 500,
        code: "INTERNAL_ERROR",
      });

      expect(deleteObjectMock).toHaveBeenCalledWith(putObjectStreamMock.mock.calls[0][0].objectKey);
      expect(enqueueRagTaskMock).not.toHaveBeenCalled();
    });

    it("marks enqueue failure only while the personal material is still UPLOADED", async () => {
      createMock.mockResolvedValue(BASE_MATERIAL);
      enqueueRagTaskMock.mockRejectedValue(new Error("Redis unavailable"));
      updateManyMock.mockResolvedValue({ count: 1 });

      await expect(uploadPersonalMaterialStream(baseUploadParams)).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });

      expect(updateManyMock).toHaveBeenCalledWith({
        where: {
          id: expect.any(String),
          userId: BASE_MATERIAL.userId,
          isDeleted: false,
          status: MaterialStatus.UPLOADED,
        },
        data: {
          status: MaterialStatus.FAILED,
          statusMessage: "QUEUE_ENQUEUE_FAILED: Redis unavailable",
        },
      });
    }, 15000);
  });

  // ─── getPersonalMaterial ──────────────────────────────────────────────────

  describe("getPersonalMaterial", () => {
    it("TC-PSVC-009: throws 404 when material does not exist", async () => {
      findFirstMock.mockResolvedValue(null);
      await expect(
        getPersonalMaterial(BASE_MATERIAL.userId, BASE_MATERIAL.id),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    });
  });

  // ─── deletePersonalMaterial ───────────────────────────────────────────────

  describe("deletePersonalMaterial", () => {
    it("TC-PSVC-010: soft-deletes material, enqueues delete task, and calls deleteObject", async () => {
      findFirstMock.mockResolvedValue(BASE_MATERIAL);
      updateMock.mockResolvedValue({ ...BASE_MATERIAL, isDeleted: true });

      await deletePersonalMaterial(BASE_MATERIAL.userId, BASE_MATERIAL.id);

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isDeleted: true } }),
      );
      expect(enqueueRagTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "personal_delete_material" }),
      );
      expect(deleteObjectMock).toHaveBeenCalledWith(BASE_MATERIAL.minioPath);
    });
  });
});
