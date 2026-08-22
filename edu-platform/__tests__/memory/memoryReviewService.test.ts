/**
 * Unit tests for memory-review core logic.
 *
 * Tests:
 *  - gradeObjectiveAnswer for all 3 question types (SINGLE_CHOICE, FILL_BLANK, TRUE_FALSE)
 *  - answerQuestion: 409 on repeat, mastery update called
 *  - getPendingSession: lazy EXPIRED when past expiresAt
 *  - createDailySession: idempotency (no duplicate for non-EXPIRED session)
 *  - dismissSession: sets DISMISSED, does NOT call updateMastery
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryReviewSessionStatus,
  MemoryReviewQuestionType,
} from "@prisma/client";
import type { PendingSessionDto } from "@/lib/services/memoryReviewService";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  sessionFindFirstMock,
  sessionFindUniqueMock,
  sessionUpdateMock,
  sessionUpsertMock,
  questionFindFirstMock,
  questionUpdateMock,
  questionFindManyMock,
  questionCreateManyMock,
  conceptUpdateManyMock,
  conceptFindFirstMock,
  conceptUpdateMock,
  coneptUpsertMock,
  enrollmentFindManyMock,
  preferenceFindFirstMock,
  preferenceUpsertMock,
  createNotificationMock,
  transactionMock,
} = vi.hoisted(() => ({
  sessionFindFirstMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  sessionUpsertMock: vi.fn(),
  questionFindFirstMock: vi.fn(),
  questionUpdateMock: vi.fn(),
  questionFindManyMock: vi.fn(),
  questionCreateManyMock: vi.fn(),
  conceptUpdateManyMock: vi.fn(),
  conceptFindFirstMock: vi.fn(),
  conceptUpdateMock: vi.fn(),
  coneptUpsertMock: vi.fn(),
  enrollmentFindManyMock: vi.fn(),
  preferenceFindFirstMock: vi.fn(),
  preferenceUpsertMock: vi.fn(),
  createNotificationMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    memoryReviewSession: {
      findFirst: sessionFindFirstMock,
      findUnique: sessionFindUniqueMock,
      update: sessionUpdateMock,
      upsert: sessionUpsertMock,
    },
    memoryReviewQuestion: {
      findFirst: questionFindFirstMock,
      findUnique: vi.fn(),
      update: questionUpdateMock,
      findMany: questionFindManyMock,
      createMany: questionCreateManyMock,
    },
    userMemoryConcept: {
      updateMany: conceptUpdateManyMock,
      findFirst: conceptFindFirstMock,
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: conceptUpdateMock,
      upsert: coneptUpsertMock,
    },
    courseEnrollment: {
      findMany: enrollmentFindManyMock,
    },
    userMemoryReviewPreference: {
      findFirst: preferenceFindFirstMock,
      upsert: preferenceUpsertMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/services/notificationService", () => ({
  createNotification: createNotificationMock,
}));

// The service uses LLM + RAG for question generation — mock those
vi.mock("@/lib/agent/llm-registry", () => ({
  getLLMClient: vi.fn(() => ({
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "[]" } }] }) } },
  })),
  getRoleConfig: vi.fn(() => ({ model: "test", apiKey: "k", baseURL: "" })),
}));

// ── Import module under test AFTER mocks ──────────────────────────────────────

import { gradeObjectiveAnswer } from "@/lib/grading/objective";
import {
  answerQuestion,
  getPendingSession,
  dismissSession,
  createDailySession,
} from "@/lib/services/memoryReviewService";

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_ID = "user-00000001";
const SESSION_ID = "sess-00000001";
const QUESTION_ID = "ques-00000001";
const CONCEPT_ID = "conc-00000001";
const TODAY = "2026-05-23";

// ── gradeObjectiveAnswer ──────────────────────────────────────────────────────

describe("gradeObjectiveAnswer", () => {
  it("is correct for matching SINGLE_CHOICE answer (case-insensitive, trimmed)", () => {
    const result = gradeObjectiveAnswer("  A  ", " a ");
    expect(result.isCorrect).toBe(true);
  });

  it("is incorrect for wrong SINGLE_CHOICE answer", () => {
    const result = gradeObjectiveAnswer("A", "B");
    expect(result.isCorrect).toBe(false);
    expect(result.correctAnswer).toBe("A");
    expect(result.feedback).toContain("A");
  });

  it("grades TRUE_FALSE correctly", () => {
    expect(gradeObjectiveAnswer("正确", "正确").isCorrect).toBe(true);
    expect(gradeObjectiveAnswer("正确", "错误").isCorrect).toBe(false);
    expect(gradeObjectiveAnswer("错误", "错误").isCorrect).toBe(true);
  });

  it("grades FILL_BLANK with trimmed case-insensitive match", () => {
    expect(gradeObjectiveAnswer("TCP/IP", "  tcp/ip  ").isCorrect).toBe(true);
    expect(gradeObjectiveAnswer("TCP/IP", "UDP").isCorrect).toBe(false);
  });

  it("returns correct feedback string on failure", () => {
    const result = gradeObjectiveAnswer("答案XYZ", "wrong");
    expect(result.feedback).toContain("答案XYZ");
  });
});

// ── answerQuestion ────────────────────────────────────────────────────────────

describe("answerQuestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSession(overrides: Partial<{
    userId: string;
    status: MemoryReviewSessionStatus;
    questionCount: number;
    answeredCount: number;
  }> = {}) {
    return {
      id: SESSION_ID,
      userId: USER_ID,
      status: MemoryReviewSessionStatus.IN_PROGRESS,
      questionCount: 3,
      answeredCount: 2,
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    };
  }

  function makeQuestion(overrides: Partial<{
    answeredAt: Date | null;
    type: MemoryReviewQuestionType;
    answer: string;
    conceptId: string | null;
    conceptName: string;
    userAnswer: string | null;
    isCorrect: boolean | null;
  }> = {}) {
    return {
      id: QUESTION_ID,
      sessionId: SESSION_ID,
      type: MemoryReviewQuestionType.SINGLE_CHOICE,
      stem: "Which layer handles routing?",
      optionsJson: JSON.stringify(["A. Network", "B. Transport", "C. Application", "D. Data Link"]),
      answer: "A. Network",
      explanation: "The Network layer routes packets.",
      conceptId: CONCEPT_ID,
      conceptName: "网络层",
      userAnswer: null,
      isCorrect: null,
      answeredAt: null,
      session: makeSession(),
      ...overrides,
    };
  }

  it("returns 409-like error if question already answered", async () => {
    questionFindFirstMock.mockResolvedValue(
      makeQuestion({ answeredAt: new Date(), userAnswer: "A. Network", isCorrect: true }),
    );

    await expect(
      answerQuestion(SESSION_ID, QUESTION_ID, USER_ID, "A. Network"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns 404-like error if session belongs to different user", async () => {
    // Service does where: { id, sessionId } then checks question.session.userId !== userId
    // If it doesn't match, it returns null → throws 404
    questionFindFirstMock.mockResolvedValue(null);

    await expect(
      answerQuestion(SESSION_ID, QUESTION_ID, USER_ID, "A. Network"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("grades correctly and updates question + session on correct answer", async () => {
    questionFindFirstMock.mockResolvedValue(makeQuestion());
    questionUpdateMock.mockResolvedValue({});
    sessionUpdateMock.mockResolvedValue({});
    transactionMock.mockResolvedValue([{}, [{ answeredAt: new Date() }, { answeredAt: new Date() }, { answeredAt: new Date() }]]);
    // updateMastery: findFirst by conceptId returns the concept
    conceptFindFirstMock.mockResolvedValue({ id: CONCEPT_ID, masteryLevel: 0.5 });
    conceptUpdateMock.mockResolvedValue({});

    const result = await answerQuestion(SESSION_ID, QUESTION_ID, USER_ID, "A. Network");

    expect(result.isCorrect).toBe(true);
    expect(questionUpdateMock).toHaveBeenCalledOnce();
    expect(conceptFindFirstMock).toHaveBeenCalledOnce();
    expect(conceptUpdateMock).toHaveBeenCalledOnce();
  });

  it("grades incorrectly and drops mastery on wrong answer", async () => {
    questionFindFirstMock.mockResolvedValue(makeQuestion());
    questionUpdateMock.mockResolvedValue({});
    sessionUpdateMock.mockResolvedValue({});
    transactionMock.mockResolvedValue([{}, [{ answeredAt: new Date() }, { answeredAt: null }]]);
    conceptFindFirstMock.mockResolvedValue({ id: CONCEPT_ID, masteryLevel: 0.6 });
    conceptUpdateMock.mockResolvedValue({});

    const result = await answerQuestion(SESSION_ID, QUESTION_ID, USER_ID, "B. Transport");

    expect(result.isCorrect).toBe(false);
    expect(conceptUpdateMock).toHaveBeenCalledOnce();
    // Verify mastery level decreased
    const updateCall = conceptUpdateMock.mock.calls[0][0] as { data: { masteryLevel: number } };
    expect(updateCall.data.masteryLevel).toBeLessThan(0.6);
  });

  it("marks session COMPLETED when last question is answered", async () => {
    questionFindFirstMock.mockResolvedValue(makeQuestion());
    questionUpdateMock.mockResolvedValue({});
    sessionUpdateMock.mockResolvedValue({});
    transactionMock.mockResolvedValue([{}, [{ answeredAt: new Date() }, { answeredAt: new Date() }, { answeredAt: new Date() }]]);
    conceptFindFirstMock.mockResolvedValue({ id: CONCEPT_ID, masteryLevel: 0.5 });
    conceptUpdateMock.mockResolvedValue({});

    await answerQuestion(SESSION_ID, QUESTION_ID, USER_ID, "A. Network");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedCall = (sessionUpdateMock.mock.calls as any[][]).find(
      ([args]) => args?.data?.status === MemoryReviewSessionStatus.COMPLETED,
    );
    expect(completedCall).toBeDefined();
  });
});

// ── getPendingSession ─────────────────────────────────────────────────────────

describe("getPendingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no pending session exists", async () => {
    sessionFindFirstMock.mockResolvedValue(null);
    const result = await getPendingSession(USER_ID);
    expect(result).toBeNull();
  });

  it("marks session EXPIRED and returns null if past expiresAt", async () => {
    sessionFindFirstMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      status: MemoryReviewSessionStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000), // past
      questionCount: 3,
      answeredCount: 0,
      questions: [],
    });
    sessionUpdateMock.mockResolvedValue({});

    const result = await getPendingSession(USER_ID);

    expect(sessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SESSION_ID },
        data: { status: MemoryReviewSessionStatus.EXPIRED },
      }),
    );
    expect(result).toBeNull();
  });

  it("returns a DTO without answer/explanation fields", async () => {
    const futureExpiry = new Date(Date.now() + 3600_000);
    sessionFindFirstMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      status: MemoryReviewSessionStatus.PENDING,
      expiresAt: futureExpiry,
      questionCount: 2,
      answeredCount: 0,
      questions: [
        {
          id: QUESTION_ID,
          type: MemoryReviewQuestionType.SINGLE_CHOICE,
          stem: "Which layer?",
          optionsJson: JSON.stringify(["A", "B"]),
          answer: "A",                    // should be stripped
          explanation: "Because A",       // should be stripped
          conceptName: "网络层",
          userAnswer: null,
          isCorrect: null,
          answeredAt: null,
        },
      ],
    });

    const result = await getPendingSession(USER_ID);

    expect(result).not.toBeNull();
    const questions = (result as PendingSessionDto).questions;
    expect(questions[0]).not.toHaveProperty("answer");
    expect(questions[0]).not.toHaveProperty("explanation");
  });
});

// ── dismissSession ────────────────────────────────────────────────────────────

describe("dismissSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets session status to DISMISSED", async () => {
    sessionFindFirstMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      status: MemoryReviewSessionStatus.PENDING,
    });
    sessionUpdateMock.mockResolvedValue({});

    await dismissSession(SESSION_ID, USER_ID);

    expect(sessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MemoryReviewSessionStatus.DISMISSED },
      }),
    );
  });

  it("throws 404 if session not found (e.g. wrong user or non-existent)", async () => {
    // Service queries where: { id, userId } — different userId returns null → 404
    sessionFindFirstMock.mockResolvedValue(null);

    await expect(dismissSession(SESSION_ID, "wrong-user")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("does NOT call mastery update on dismiss", async () => {
    sessionFindFirstMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      status: MemoryReviewSessionStatus.PENDING,
    });
    sessionUpdateMock.mockResolvedValue({});

    await dismissSession(SESSION_ID, USER_ID);

    expect(conceptUpdateManyMock).not.toHaveBeenCalled();
  });
});

// ── createDailySession idempotency ────────────────────────────────────────────

describe("createDailySession idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips creation when a non-EXPIRED session already exists for that date", async () => {
    // Service calls findUnique with composite key userId_scheduledDate
    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      scheduledDate: TODAY,
      status: MemoryReviewSessionStatus.PENDING,
    });

    const result = await createDailySession(USER_ID, TODAY);

    // Should return early with created: false
    expect(result).toMatchObject({ sessionId: SESSION_ID, created: false });
    expect(sessionUpsertMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});
