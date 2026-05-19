/**
 * TC-SUB-001: Assignment submission constraint tests.
 * Verifies submission uniqueness, status constraints, and deadline checks.
 * No real DB / LLM required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AssignmentStatus,
  SubmissionStatus,
  UserRole,
} from "@prisma/client";

const {
  getCourseIfMemberMock,
  assignmentFindFirstMock,
  submissionFindUniqueMock,
  submissionUpsertMock,
} = vi.hoisted(() => ({
  getCourseIfMemberMock: vi.fn(),
  assignmentFindFirstMock: vi.fn(),
  submissionFindUniqueMock: vi.fn(),
  submissionUpsertMock: vi.fn(),
}));

vi.mock("@/lib/course-access", () => ({
  assertTeacherOfCourse: vi.fn(),
  getCourseIfMember: getCourseIfMemberMock,
  assertUuid: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    assignment: {
      findFirst: assignmentFindFirstMock,
    },
    assignmentSubmission: {
      findUnique: submissionFindUniqueMock,
      upsert: submissionUpsertMock,
    },
  },
}));

// next/server after() is a no-op in tests
vi.mock("next/server", () => ({
  after: vi.fn(),
}));

vi.mock("@/lib/agent/llm-registry", () => ({
  getLLMClient: vi.fn(() => ({})),
  getRoleConfig: vi.fn(() => ({ model: "test", apiKey: "k", baseURL: "" })),
}));

vi.mock("@/lib/agent/tracing/langfuse-tracer", () => ({
  createStandaloneTrace: vi.fn(() => ({ id: "trace-1" })),
  flushLangfuse: vi.fn(),
  recordGeneration: vi.fn(),
}));

const ASSIGNMENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COURSE_ID = "11111111-2222-3333-4444-555555555555";
const STUDENT_ID = "student-uuid-001";

function makeAssignment(
  status: AssignmentStatus,
  deadline: Date | null = null,
) {
  return {
    id: ASSIGNMENT_ID,
    courseId: COURSE_ID,
    title: "Test Assignment",
    status,
    questions: [
      {
        id: "q1",
        type: "single_choice",
        question: "What is 2+2?",
        options: ["3", "4", "5", "6"],
        answer: "4",
        explanation: "Basic math",
        score: 10,
      },
    ],
    deadline,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    publishedAt: new Date("2026-01-01T01:00:00Z"),
    errorMessage: null,
  };
}

describe("submitAssignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCourseIfMemberMock.mockResolvedValue({ id: COURSE_ID });
    submissionFindUniqueMock.mockResolvedValue(null);
    submissionUpsertMock.mockResolvedValue({
      id: "sub-uuid-001",
      assignmentId: ASSIGNMENT_ID,
      studentId: STUDENT_ID,
      student: { realName: "Alice", username: "alice" },
      status: SubmissionStatus.SUBMITTED,
      answers: [],
      gradingResult: null,
      teacherFeedback: null,
      submittedAt: new Date(),
      gradedAt: null,
      returnedAt: null,
    });
  });

  it("TC-SUB-001: student can submit a published assignment - returns SUBMITTED status", async () => {
    assignmentFindFirstMock.mockResolvedValue(
      makeAssignment(AssignmentStatus.PUBLISHED),
    );

    const { submitAssignment } = await import(
      "@/lib/services/submissionService"
    );

    const result = await submitAssignment(
      STUDENT_ID,
      UserRole.STUDENT,
      COURSE_ID,
      ASSIGNMENT_ID,
      { answers: [{ questionId: "q1", answer: "4" }] },
    );

    expect(result.status).toBe(SubmissionStatus.SUBMITTED);
    expect(submissionUpsertMock).toHaveBeenCalledOnce();
  });

  it("TC-SUB-001: unpublished assignment (DRAFT) should throw 400", async () => {
    assignmentFindFirstMock.mockResolvedValue(
      makeAssignment(AssignmentStatus.DRAFT),
    );

    const { submitAssignment } = await import(
      "@/lib/services/submissionService"
    );

    await expect(
      submitAssignment(
        STUDENT_ID,
        UserRole.STUDENT,
        COURSE_ID,
        ASSIGNMENT_ID,
        { answers: [] },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(submissionUpsertMock).not.toHaveBeenCalled();
  });

  it("TC-SUB-001: past deadline should throw 403 DEADLINE_PASSED", async () => {
    const pastDeadline = new Date(Date.now() - 1000 * 60 * 60);
    assignmentFindFirstMock.mockResolvedValue(
      makeAssignment(AssignmentStatus.PUBLISHED, pastDeadline),
    );

    const { submitAssignment } = await import(
      "@/lib/services/submissionService"
    );

    await expect(
      submitAssignment(
        STUDENT_ID,
        UserRole.STUDENT,
        COURSE_ID,
        ASSIGNMENT_ID,
        { answers: [] },
      ),
    ).rejects.toMatchObject({ status: 403, code: "DEADLINE_PASSED" });
  });

  it("TC-SUB-001: RETURNED submission cannot be resubmitted - throws 409 ALREADY_RETURNED", async () => {
    assignmentFindFirstMock.mockResolvedValue(
      makeAssignment(AssignmentStatus.PUBLISHED),
    );
    submissionFindUniqueMock.mockResolvedValue({
      id: "old-sub",
      status: SubmissionStatus.RETURNED,
    });

    const { submitAssignment } = await import(
      "@/lib/services/submissionService"
    );

    await expect(
      submitAssignment(
        STUDENT_ID,
        UserRole.STUDENT,
        COURSE_ID,
        ASSIGNMENT_ID,
        { answers: [] },
      ),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_RETURNED" });
  });

  it("TEACHER role cannot submit assignments - should throw 403", async () => {
    const { submitAssignment } = await import(
      "@/lib/services/submissionService"
    );

    await expect(
      submitAssignment(
        STUDENT_ID,
        UserRole.TEACHER,
        COURSE_ID,
        ASSIGNMENT_ID,
        { answers: [] },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
