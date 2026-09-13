import { Readable } from "node:stream";
import {
  MaterialPreviewPdfStatus,
  MaterialStatus,
  UserRole,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadMaterialStream } from "@/lib/services/materialService";

const {
  createMaterialMock,
  updateManyMock,
  enqueueRagTaskMock,
  putObjectStreamMock,
  deleteObjectMock,
  assertTeacherOfCourseMock,
  findLessonMock,
  createNotificationMock,
} = vi.hoisted(() => ({
  createMaterialMock: vi.fn(),
  updateManyMock: vi.fn(),
  enqueueRagTaskMock: vi.fn(),
  putObjectStreamMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  assertTeacherOfCourseMock: vi.fn(),
  findLessonMock: vi.fn(),
  createNotificationMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    material: {
      create: createMaterialMock,
      updateMany: updateManyMock,
    },
    lesson: {
      findFirst: findLessonMock,
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getMaterialMaxUploadBytes: vi.fn(() => 1024 * 1024),
  getMinioConfig: vi.fn(() => ({ endpoint: "http://127.0.0.1:9000" })),
  getRedisUrl: vi.fn(() => "redis://localhost:6379"),
}));

vi.mock("@/lib/course-access", () => ({
  assertTeacherOfCourse: assertTeacherOfCourseMock,
  getCourseIfMember: vi.fn(),
  assertUuid: vi.fn(),
}));

vi.mock("@/lib/minio", () => ({
  deleteObject: deleteObjectMock,
  getObjectStream: vi.fn(),
  putObjectStream: putObjectStreamMock,
}));

vi.mock("@/lib/queue/ragTask", () => ({
  enqueueRagTask: enqueueRagTaskMock,
}));

vi.mock("@/lib/services/notificationService", () => ({
  createNotification: createNotificationMock,
  createBulkNotifications: vi.fn().mockResolvedValue(undefined),
}));

describe("uploadMaterialStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMaterialMock.mockResolvedValue({
      id: "mat-1",
      originalFilename: "slides.pptx",
      status: MaterialStatus.UPLOADED,
      createdAt: new Date("2026-05-13T00:00:00.000Z"),
      previewPdfStatus: MaterialPreviewPdfStatus.PENDING,
    });
    putObjectStreamMock.mockResolvedValue(undefined);
    deleteObjectMock.mockResolvedValue(undefined);
    enqueueRagTaskMock.mockResolvedValue(undefined);
    updateManyMock.mockResolvedValue({ count: 1 });
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
    createNotificationMock.mockResolvedValue(undefined);
  });

  it("preserves text_only on initial office convert_preview task", async () => {
    await uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      originalFilename: "slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      contentLength: 128,
      body: Readable.from(["pptx"]),
      textOnly: false,
    });

    expect(enqueueRagTaskMock).toHaveBeenCalledTimes(1);
    expect(enqueueRagTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "convert_preview",
        text_only: false,
      }),
    );
  }, 15000);

  it("keeps course ownership, lesson validation, storage path, and teacher notification", async () => {
    findLessonMock.mockResolvedValue({ id: "lesson-1" });

    const created = await uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      lessonId: "lesson-1",
      originalFilename: "slides.pptx",
      contentType: "application/pdf",
      contentLength: 128,
      body: Readable.from(["pptx"]),
    });

    expect(assertTeacherOfCourseMock).toHaveBeenCalledWith("teacher-1", UserRole.TEACHER, "course-1");
    expect(findLessonMock).toHaveBeenCalledWith({
      where: { id: "lesson-1", courseId: "course-1", isDeleted: false },
    });
    const objectKey = putObjectStreamMock.mock.calls[0][0].objectKey as string;
    expect(objectKey).toMatch(/^materials\/course-1\/[^/]+\/slides\.pptx$/);
    expect(createMaterialMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        courseId: "course-1",
        lessonId: "lesson-1",
        minioPath: objectKey,
        previewPdfStatus: MaterialPreviewPdfStatus.PENDING,
        status: MaterialStatus.UPLOADED,
      }),
    });
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "teacher-1",
      metadata: { courseId: "course-1", materialId: created.id },
    }));
  });

  it("checks course teaching permission before storing a file", async () => {
    assertTeacherOfCourseMock.mockRejectedValue(new Error("Not a course teacher"));

    await expect(uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      originalFilename: "notes.pdf",
      contentType: "application/pdf",
      contentLength: 128,
      body: Readable.from(["pdf"]),
    })).rejects.toThrow("Not a course teacher");

    expect(putObjectStreamMock).not.toHaveBeenCalled();
    expect(createMaterialMock).not.toHaveBeenCalled();
    expect(enqueueRagTaskMock).not.toHaveBeenCalled();
  });

  it("does not create a course record when object storage fails", async () => {
    putObjectStreamMock.mockRejectedValue(new Error("MinIO unavailable"));

    await expect(uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      originalFilename: "notes.pdf",
      contentType: "application/pdf",
      contentLength: 128,
      body: Readable.from(["pdf"]),
    })).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });

    expect(createMaterialMock).not.toHaveBeenCalled();
    expect(enqueueRagTaskMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("cleans up the course object when DB creation fails", async () => {
    createMaterialMock.mockRejectedValue(new Error("DB unavailable"));

    await expect(uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      originalFilename: "notes.pdf",
      contentType: "application/pdf",
      contentLength: 128,
      body: Readable.from(["pdf"]),
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });

    expect(deleteObjectMock).toHaveBeenCalledWith(putObjectStreamMock.mock.calls[0][0].objectKey);
    expect(enqueueRagTaskMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("marks a course upload FAILED when the initial task cannot be queued", async () => {
    enqueueRagTaskMock.mockRejectedValue(new Error("Redis unavailable"));

    await expect(uploadMaterialStream({
      teacherUserId: "teacher-1",
      role: UserRole.TEACHER,
      courseId: "course-1",
      originalFilename: "slides.pptx",
      contentType: "application/pdf",
      contentLength: 128,
      body: Readable.from(["pptx"]),
    })).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });

    expect(enqueueRagTaskMock).toHaveBeenCalledTimes(5);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        isDeleted: false,
        status: MaterialStatus.UPLOADED,
      },
      data: {
        status: MaterialStatus.FAILED,
        statusMessage: "QUEUE_ENQUEUE_FAILED: Redis unavailable",
      },
    });
    expect(createNotificationMock).not.toHaveBeenCalled();
  }, 15000);
});
