/**
 * Integration tests: MinIO (S3-compatible object storage)
 *
 * Tests real object storage operations using the configured MINIO_* env vars.
 * All objects use an isolated test key prefix and are deleted on cleanup.
 *
 * TC-MINIO-001: Object upload (PutObject) + existence check
 * TC-MINIO-002: Object download (GetObject) + content verification
 * TC-MINIO-003: Range request returns partial content
 * TC-MINIO-004: Object deletion removes the object
 */
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { deleteObject, getObjectStream, objectExists, putObjectStream } from "@/lib/minio";

const TEST_PREFIX = `integration-test/${Date.now()}`;
const TEXT_KEY = `${TEST_PREFIX}/hello.txt`;
const TEXT_CONTENT = "Hello, MinIO integration test!\nLine two here.";

describe("MinIO integration", () => {
  afterAll(async () => {
    // Best-effort cleanup — ignore errors if already deleted
    await deleteObject(TEXT_KEY).catch(() => {});
  });

  // ─── TC-MINIO-001: Upload + existence check ────────────────────────────────

  describe("TC-MINIO-001: upload and objectExists", () => {
    it("putObjectStream uploads a text file without throwing", async () => {
      const buf = Buffer.from(TEXT_CONTENT, "utf8");
      await expect(
        putObjectStream({
          objectKey: TEXT_KEY,
          body: Readable.from(buf),
          contentLength: buf.length,
          contentType: "text/plain",
        }),
      ).resolves.not.toThrow();
    });

    it("objectExists returns true for the uploaded object", async () => {
      const exists = await objectExists(TEXT_KEY);
      expect(exists).toBe(true);
    });

    it("objectExists returns false for a non-existent key", async () => {
      const exists = await objectExists(`${TEST_PREFIX}/no-such-file.bin`);
      expect(exists).toBe(false);
    });
  });

  // ─── TC-MINIO-002: Download + content verification ────────────────────────

  describe("TC-MINIO-002: download and verify content", () => {
    it("getObjectStream returns the correct content-type", async () => {
      const result = await getObjectStream({ objectKey: TEXT_KEY });
      expect(result.contentType).toBe("text/plain");
    });

    it("getObjectStream body stream contains the uploaded text", async () => {
      const result = await getObjectStream({ objectKey: TEXT_KEY });
      const webStream = result.body as ReadableStream<Uint8Array>;
      const reader = webStream.getReader();
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (value) chunks.push(value);
        done = d;
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      expect(text).toBe(TEXT_CONTENT);
    });

    it("contentLength matches the uploaded size", async () => {
      const result = await getObjectStream({ objectKey: TEXT_KEY });
      expect(result.contentLength).toBe(Buffer.byteLength(TEXT_CONTENT, "utf8"));
    });
  });

  // ─── TC-MINIO-003: Range request ──────────────────────────────────────────

  describe("TC-MINIO-003: Range (partial content)", () => {
    it("range request returns isPartial=true and correct byte slice", async () => {
      const result = await getObjectStream({
        objectKey: TEXT_KEY,
        range: "bytes=0-4",
      });
      expect(result.isPartial).toBe(true);
      const webStream = result.body as ReadableStream<Uint8Array>;
      const reader = webStream.getReader();
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (value) chunks.push(value);
        done = d;
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      expect(text).toBe("Hello");
    });
  });

  // ─── TC-MINIO-004: Delete ─────────────────────────────────────────────────

  describe("TC-MINIO-004: object deletion", () => {
    it("deleteObject removes the object so objectExists returns false", async () => {
      await deleteObject(TEXT_KEY);
      const exists = await objectExists(TEXT_KEY);
      expect(exists).toBe(false);
    });
  });
});
