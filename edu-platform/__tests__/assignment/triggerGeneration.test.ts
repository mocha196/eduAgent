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
  xAddMock,
  getRedisMock,
} = vi.hoisted(() => ({
  assertTeacherOfCourseMock: vi.fn(),
  assignmentCreateMock: vi.fn(),
  assignmentDeleteMock: vi.fn(),
  assignmentFindFirstMock: vi.fn(),
  assignmentUpdateMock: vi.fn(),
  xAddMock: vi.fn(),
  getRedisMock: vi.fn(),
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
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  getRedis: getRedisMock,
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
  };
}

describe("triggerAssignmentGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
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
    assignmentFindFirstMock.mockResolvedValue(draftAssignment);
    assignmentUpdateMock.mockResolvedValue({
      ...draftAssignment,
      title: "Updated Title",
    });

    const { patchAssignment } = await import("@/lib/services/assignmentService");

    const result = await patchAssignment(
      TEACHER_ID,
      UserRole.TEACHER,
      COURSE_ID,
      ASSIGNMENT_ID,
      { title: "Updated Title" },
    );

    expect(result.id).toBe(ASSIGNMENT_ID);
    expect(assignmentUpdateMock).toHaveBeenCalled();
  });
});

describe("publishAssignment state machine (TC-ASSIGN-002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTeacherOfCourseMock.mockResolvedValue(undefined);
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
    assignmentFindFirstMock.mockResolvedValue(draftAssignment);
    assignmentUpdateMock.mockResolvedValue({
      ...draftAssignment,
      status: AssignmentStatus.PUBLISHED,
      publishedAt: new Date(),
    });

    const { publishAssignment } = await import("@/lib/services/assignmentService");

    const result = await publishAssignment(
      TEACHER_ID,
      UserRole.TEACHER,
      COURSE_ID,
      ASSIGNMENT_ID,
    );

    expect(result.status).toBe(AssignmentStatus.PUBLISHED);
    expect(assignmentUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: AssignmentStatus.PUBLISHED }),
      }),
    );
  });
});
