import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubmissionStatus } from "@prisma/client";

const { updateManyMock, findFirstMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    assignmentSubmission: {
      updateMany: updateManyMock,
      findFirst: findFirstMock,
    },
  },
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/course-access", () => ({
  assertTeacherOfCourse: vi.fn(),
  getCourseIfMember: vi.fn(),
  assertUuid: vi.fn(),
}));
vi.mock("@/lib/services/notificationService", () => ({
  createNotification: vi.fn(),
  createBulkNotifications: vi.fn(),
}));
vi.mock("@/lib/agent/user-llm-store", () => ({
  runWithUserLlm: vi.fn(async (_userId: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/agent/llm-registry", () => ({
  getLLMClient: vi.fn(() => ({})),
  getMemoryModel: vi.fn(() => "test"),
  getRoleConfig: vi.fn(() => ({ model: "test", apiKey: "k", baseURL: "" })),
}));
vi.mock("@/lib/agent/tracing/langfuse-tracer", () => ({
  createStandaloneTrace: vi.fn(),
  flushLangfuse: vi.fn(),
  recordGeneration: vi.fn(),
}));

describe("triggerGrading concurrency guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not start a second grader when the atomic claim loses", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    const { triggerGrading } = await import("@/lib/services/submissionService");

    await triggerGrading("sub-1");

    expect(updateManyMock).toHaveBeenCalledOnce();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("commits a grade only with the token owned by the grading attempt", async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    findFirstMock.mockResolvedValue({
      id: "sub-1",
      studentId: "student-1",
      status: SubmissionStatus.GRADING,
      answers: [{ questionId: 1, answer: "4" }],
      assignment: {
        questions: [{
          id: 1,
          type: "single_choice",
          question: "2+2?",
          answer: "4",
          explanation: "",
          score: 10,
        }],
      },
    });
    const { triggerGrading } = await import("@/lib/services/submissionService");

    await triggerGrading("sub-1");

    const claim = updateManyMock.mock.calls[0][0];
    const commit = updateManyMock.mock.calls[1][0];
    expect(claim.where.status).toBe(SubmissionStatus.SUBMITTED);
    expect(commit.where).toMatchObject({
      id: "sub-1",
      status: SubmissionStatus.GRADING,
      gradingToken: claim.data.gradingToken,
    });
  });
});
