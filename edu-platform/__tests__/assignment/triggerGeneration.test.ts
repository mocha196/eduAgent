/**
 * TC-ASSIGN-001/002: Assignment service state machine and Redis rollback tests.
 * No real DB / Redis / LLM required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssignmentStatus, UserRole } from "@prisma/client";

const {
  assertTeacherOfCourseMock,
  assignmentCreateMock,
  assignmentDeleteMock,
  assignmentFindFirstMock,
  assignmentUpdateMock,
  assignmentUpdateManyMock,
  xAddMock,
  getRedisMock,
  transactionMock,
} = vi.hoisted(() => ({
  assertTeacherOfCourseMock: vi.fn(),
  assignmentCreateMock: vi.fn(),
  assignmentDeleteMock: vi.fn(),
  assignmentFindFirstMock: vi.fn(),
  assignmentUpdateMock: vi.fn(),
  assignmentUpdateManyMock: vi.fn(),
  xAddMock: vi.fn(),
  getRedisMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/course-access", () => ({
  assertTeacherOfCourse: assertTeacherOfCourseMock,
  getCourseIfMember: vi.fn(),
  assertUuid: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    assignment: {
      create: assignmentCreateMock,
      delete: assignmentDeleteMock,
      findFirst: assignmentFindFirstMock,
      update: assignmentUpdateMock,
      updateMany: assignmentUpdateManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/redis", () => ({
  getRedis: getRedisMock,
}));

vi.mock("@/lib/services/notificationService", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createBulkNotifications: vi.fn().mockResolvedValue(undefined),
}));

const ASSIGNMENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COURSE_ID = "11111111-2222-3333-4444-555555555555";
const TEACHER_ID = "teacher-uuid-001";

function makeAssignment(status: AssignmentStatus) {
  return {
    id: ASSIGNMENT_ID,
    title: "Test Assignment",
    status,
    description: null,
    questions: null,
    blueprint: null,
    qualityReport: null,
    deadline: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    publishedAt: null,
    errorMessage: null,
    teacherRequest: "generate 5 MCQ",
    structuredParams: null,
    generatedQuestionsSnapshot: null,
    adoptionMetrics: null,
  };
}

describe("triggerAssignmentGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
    transactionMock.mockImplementation(async (callback) => callback({
      assignment: {
        findFirst: assignmentFindFirstMock,
        updateMany: assignmentUpdateManyMock,
      },
    }));
    assignmentDeleteMock.mockResolvedValue(undefined);
  });

  it("TC-ASSIGN-001: Redis xAdd failure should delete the created assignment and throw 503", async () => {
    assignmentCreateMock.mockResolvedValue(makeAssignment(AssignmentStatus.GENERATING));
    xAddMock.mockRejectedValue(new Error("Redis connection refused"));
    getRedisMock.mockResolvedValue({ xAdd: xAddMock });

    const { triggerAssignmentGeneration } = await import(
      "@/lib/services/assignmentService"
    );

    await expect(
      triggerAssignmentGeneration(TEACHER_ID, UserRole.TEACHER, COURSE_ID, {
        title: "Test Assignment",
        teacherRequest: "generate 5 MCQ",
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(assignmentDeleteMock).toHaveBeenCalledWith({
      where: { id: ASSIGNMENT_ID },
    });
  });

  it("TC-ASSIGN-001: getRedis failure should also rollback the assignment", async () => {
    assignmentCreateMock.mockResolvedValue(makeAssignment(AssignmentStatus.GENERATING));
    getRedisMock.mockRejectedValue(new Error("REDIS_URL not configured"));

    const { triggerAssignmentGeneration } = await import(
      "@/lib/services/assignmentService"
    );

    await expect(
      triggerAssignmentGeneration(TEACHER_ID, UserRole.TEACHER, COURSE_ID, {
        title: "Another Assignment",
        teacherRequest: "generate 3 essay questions",
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(assignmentDeleteMock).toHaveBeenCalled();
  });

  it("success: returns GENERATING status summary when queued successfully", async () => {
    assignmentCreateMock.mockResolvedValue(makeAssignment(AssignmentStatus.GENERATING));
    xAddMock.mockResolvedValue("stream-id-001");
    getRedisMock.mockResolvedValue({ xAdd: xAddMock });

    const { triggerAssignmentGeneration } = await import(
      "@/lib/services/assignmentService"
    );

    const result = await triggerAssignmentGeneration(
      TEACHER_ID,
      UserRole.TEACHER,
      COURSE_ID,
      { title: "Good Assignment", teacherRequest: "generate 5 MCQ" },
    );

    expect(result.status).toBe(AssignmentStatus.GENERATING);
    expect(result.id).toBe(ASSIGNMENT_ID);
    expect(assignmentDeleteMock).not.toHaveBeenCalled();
  });
});

describe("calculateQuestionAdoption", () => {
  it("distinguishes retained, modified, deleted, and teacher-added questions", async () => {
    const { calculateQuestionAdoption } = await import("@/lib/services/assignmentService");
    const base = {
      type: "single_choice" as const,
      objective: "knowledge" as const,
      entities: ["TCP"],
      importance_score: 1,
      reasoning_steps: 1,
      options: ["A", "B"],
      answer: "A",
      explanation: "Because",
      source_chunk_ids: ["chunk-1"],
      score: 5,
      difficulty: "easy" as const,
    };
    const generated = [
      { ...base, id: 1, question: "Q1" },
      { ...base, id: 2, question: "Q2" },
      { ...base, id: 3, question: "Q3" },
    ];
    const published = [
      { ...generated[0], score: 10 },
      { ...generated[1], question: "Q2 edited" },
      { ...base, id: 999, question: "Teacher question" },
    ];

    const metrics = calculateQuestionAdoption(
      generated,
      published,
      new Date("2026-09-08T00:00:00.000Z"),
    );

    expect(metrics).toEqual({
      generatedCount: 3,
      retainedCount: 2,
      unchangedCount: 1,
      modifiedCount: 1,
      deletedCount: 1,
      teacherAddedCount: 1,
      adoptionRate: 2 / 3,
      directAdoptionRate: 1 / 3,
      calculatedAt: "2026-09-08T00:00:00.000Z",
    });
  });

  it("returns zero rates for legacy assignments without a generated snapshot", async () => {
    const { calculateQuestionAdoption } = await import("@/lib/services/assignmentService");
    const metrics = calculateQuestionAdoption([], []);
    expect(metrics.generatedCount).toBe(0);
    expect(metrics.adoptionRate).toBe(0);
    expect(metrics.directAdoptionRate).toBe(0);
  });
});

describe("patchAssignment state machine (TC-ASSIGN-002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
  });

  it("GENERATING status cannot be patched - should throw 409", async () => {
    assignmentFindFirstMock.mockResolvedValue(makeAssignment(AssignmentStatus.GENERATING));

    const { patchAssignment } = await import("@/lib/services/assignmentService");

    await expect(
      patchAssignment(TEACHER_ID, UserRole.TEACHER, COURSE_ID, ASSIGNMENT_ID, {
        title: "New Title",
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(assignmentUpdateMock).not.toHaveBeenCalled();
  });

  it("PUBLISHED status cannot be patched - should throw 409", async () => {
    assignmentFindFirstMock.mockResolvedValue(makeAssignment(AssignmentStatus.PUBLISHED));

    const { patchAssignment } = await import("@/lib/services/assignmentService");

    await expect(
      patchAssignment(TEACHER_ID, UserRole.TEACHER, COURSE_ID, ASSIGNMENT_ID, {
        title: "New Title",
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(assignmentUpdateMock).not.toHaveBeenCalled();
  });

  it("DRAFT status can be patched - should call update", async () => {
    const draftAssignment = makeAssignment(AssignmentStatus.DRAFT);
    assignmentFindFirstMock
      .mockResolvedValueOnce(draftAssignment)
      .mockResolvedValueOnce({
      ...draftAssignment,
      title: "Updated Title",
      });
    assignmentUpdateManyMock.mockResolvedValue({ count: 1 });

    const { patchAssignment } = await import("@/lib/services/assignmentService");

    const result = await patchAssignment(
      TEACHER_ID,
      UserRole.TEACHER,
      COURSE_ID,
      ASSIGNMENT_ID,
      { title: "Updated Title" },
    );

    expect(result.id).toBe(ASSIGNMENT_ID);
    expect(assignmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: AssignmentStatus.DRAFT }),
      }),
    );
  });
});

describe("publishAssignment state machine (TC-ASSIGN-002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
    transactionMock.mockImplementation(async (callback) => callback({
      assignment: {
        findFirst: assignmentFindFirstMock,
        updateMany: assignmentUpdateManyMock,
      },
    }));
  });

  it("GENERATING status cannot be published - should throw 409", async () => {
    assignmentFindFirstMock.mockResolvedValue(makeAssignment(AssignmentStatus.GENERATING));

    const { publishAssignment } = await import("@/lib/services/assignmentService");

    await expect(
      publishAssignment(TEACHER_ID, UserRole.TEACHER, COURSE_ID, ASSIGNMENT_ID),
    ).rejects.toMatchObject({ status: 409 });

    expect(assignmentUpdateMock).not.toHaveBeenCalled();
  });

  it("DRAFT status can be published - returns PUBLISHED status", async () => {
    const draftAssignment = makeAssignment(AssignmentStatus.DRAFT);
    assignmentFindFirstMock
      .mockResolvedValueOnce(draftAssignment)
      .mockResolvedValueOnce({
      ...draftAssignment,
      status: AssignmentStatus.PUBLISHED,
      publishedAt: new Date(),
      });
    assignmentUpdateManyMock.mockResolvedValue({ count: 1 });

    const { publishAssignment } = await import("@/lib/services/assignmentService");

    const result = await publishAssignment(
      TEACHER_ID,
      UserRole.TEACHER,
      COURSE_ID,
      ASSIGNMENT_ID,
    );

    expect(result.status).toBe(AssignmentStatus.PUBLISHED);
    expect(assignmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: AssignmentStatus.PUBLISHED }),
      }),
    );
  });
});
