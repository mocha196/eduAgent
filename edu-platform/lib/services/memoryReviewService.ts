/**
 * memoryReviewService — Daily spaced-repetition review session lifecycle.
 *
 * Flow:
 *  scheduler → createDailySession → notifies user via SSE
 *  user opens modal → answerQuestion (per-question, immediate feedback + mastery write)
 *  user closes modal → dismissSession (unanswered questions ⇒ no mastery change)
 */

import { prisma } from "@/lib/db";
import {
  MemoryReviewSessionStatus,
  MemoryReviewQuestionType,
  NotificationType,
  type UserMemoryConcept,
} from "@prisma/client";
import { getLLMClient, getRoleConfig } from "@/lib/agent/llm-registry";
import { gradeObjectiveAnswer } from "@/lib/grading/objective";
import { createNotification } from "@/lib/services/notificationService";

// ---------------------------------------------------------------------------
// Constants (overridable via env)
// ---------------------------------------------------------------------------

const QUESTION_COUNT = parseInt(process.env.MEMORY_REVIEW_QUESTION_COUNT ?? "5", 10);
const SESSION_TTL_HOURS = parseInt(process.env.MEMORY_REVIEW_SESSION_TTL_HOURS ?? "24", 10);
const MASTERY_BUMP = 0.08;
const MASTERY_DROP = 0.05;

// Spaced-repetition thresholds
const WEAK_MASTERY_THRESHOLD = 0.6;
const INTERVAL_REVIEW_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConceptWithCourse {
  conceptId: string;
  conceptName: string;
  masteryLevel: number;
  courseId: string | null; // best-guess course for RAG context
}

export interface ReviewQuestionPublic {
  id: string;
  type: MemoryReviewQuestionType;
  stem: string;
  options: string[] | null;
  conceptName: string;
  answeredAt: string | null;
  userAnswer: string | null;
  isCorrect: boolean | null;
}

export interface AnswerResult {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
}

export interface PendingSessionDto {
  sessionId: string;
  questionCount: number;
  answeredCount: number;
  expiresAt: string;
  questions: ReviewQuestionPublic[];
}

// ---------------------------------------------------------------------------
// 1. Preference helpers
// ---------------------------------------------------------------------------

export async function getOrCreatePreference(userId: string) {
  return prisma.userMemoryReviewPreference.upsert({
    where: { userId },
    create: { userId, enabled: true, localTime: "09:00", timezone: "Asia/Shanghai" },
    update: {},
  });
}

export async function updatePreference(
  userId: string,
  data: { enabled?: boolean; localTime?: string; timezone?: string },
) {
  return prisma.userMemoryReviewPreference.upsert({
    where: { userId },
    create: {
      userId,
      enabled: data.enabled ?? true,
      localTime: data.localTime ?? "09:00",
      timezone: data.timezone ?? "Asia/Shanghai",
    },
    update: data,
  });
}

// ---------------------------------------------------------------------------
// 2. Select concepts for review (spaced-repetition strategy)
// ---------------------------------------------------------------------------

async function selectConceptsForReview(
  userId: string,
  limit: number = QUESTION_COUNT,
): Promise<ConceptWithCourse[]> {
  const allConcepts = await prisma.userMemoryConcept.findMany({
    where: { userId },
    orderBy: { masteryLevel: "asc" },
  });

  if (allConcepts.length === 0) return [];

  const now = new Date();
  const intervalCutoff = new Date(now.getTime() - INTERVAL_REVIEW_DAYS * 24 * 60 * 60 * 1000);

  // Priority 1: weak concepts (mastery < threshold)
  const weak = allConcepts.filter((c) => c.masteryLevel < WEAK_MASTERY_THRESHOLD);
  // Priority 2: concepts due for spaced review
  const due = allConcepts.filter(
    (c) => c.masteryLevel >= WEAK_MASTERY_THRESHOLD && c.lastUpdated < intervalCutoff,
  );

  // Merge with priority order, then take limit
  const selected: UserMemoryConcept[] = [];
  for (const c of [...weak, ...due]) {
    if (selected.length >= limit) break;
    if (!selected.find((s) => s.id === c.id)) selected.push(c);
  }
  // Fill remaining from the rest sorted by mastery asc
  if (selected.length < limit) {
    for (const c of allConcepts) {
      if (selected.length >= limit) break;
      if (!selected.find((s) => s.id === c.id)) selected.push(c);
    }
  }

  // Bind each concept to a course (for potential RAG use)
  const enrollments = await prisma.courseEnrollment.findMany({
    where: { studentId: userId },
    select: { courseId: true },
  });
  const courseIds = enrollments.map((e) => e.courseId);

  // Find courses with READY materials (indicates KG is available)
  const readyCourses = courseIds.length
    ? await prisma.material.findMany({
        where: { courseId: { in: courseIds }, status: "READY", isDeleted: false },
        select: { courseId: true },
        distinct: ["courseId"],
      })
    : [];
  const readyCourseSet = new Set(readyCourses.map((m) => m.courseId));

  return selected.map((c) => ({
    conceptId: c.id,
    conceptName: c.name,
    masteryLevel: c.masteryLevel,
    // Prefer a course with READY material; fall back to any enrolled course
    courseId: readyCourseSet.size > 0 ? (readyCourseSet.values().next().value ?? null) : (courseIds[0] ?? null),
  }));
}

// ---------------------------------------------------------------------------
// 3. Question generation helpers
// ---------------------------------------------------------------------------

interface RawQuestion {
  type: MemoryReviewQuestionType;
  stem: string;
  options: string[] | null;
  answer: string;
  explanation: string;
  conceptName: string;
  conceptId: string | null;
  courseId: string | null;
}

/**
 * Call the RAG service to generate questions for a given course,
 * then keep only SINGLE_CHOICE and FILL_BLANK (RAG doesn't support TRUE_FALSE).
 */
async function generateViaRag(
  courseId: string,
  count: number,
  conceptName: string,
  conceptId: string | null,
): Promise<RawQuestion[]> {
  const ragUrl = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/$/, "");
  const key = process.env.INTERNAL_API_KEY ?? "";

  try {
    const res = await fetch(`${ragUrl}/rag/generate-quiz`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": key,
      },
      body: JSON.stringify({ course_id: courseId, count: Math.min(count * 2, 10), question_type: "mixed" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { questions: Array<Record<string, unknown>> };

    const allowed = new Set<string>(["single_choice", "fill_blank"]);
    return (data.questions ?? [])
      .filter((q) => allowed.has(q.type as string))
      .slice(0, count)
      .map((q) => ({
        type: q.type === "single_choice" ? MemoryReviewQuestionType.SINGLE_CHOICE : MemoryReviewQuestionType.FILL_BLANK,
        stem: String(q.question ?? q.stem ?? ""),
        options: Array.isArray(q.options) ? (q.options as string[]) : null,
        answer: String(q.answer ?? ""),
        explanation: String(q.explanation ?? ""),
        conceptName,
        conceptId,
        courseId,
      }));
  } catch {
    return [];
  }
}

/** Type distribution for LLM generation (cycles through types). */
const TYPE_CYCLE: MemoryReviewQuestionType[] = [
  MemoryReviewQuestionType.SINGLE_CHOICE,
  MemoryReviewQuestionType.FILL_BLANK,
  MemoryReviewQuestionType.TRUE_FALSE,
];

/**
 * Ask the LLM to generate a single review question for a concept.
 * true_false only comes from this path (RAG doesn't support it).
 */
async function generateViaLlm(
  concept: ConceptWithCourse,
  questionType: MemoryReviewQuestionType,
): Promise<RawQuestion | null> {
  const { model } = getRoleConfig("memory");
  const client = getLLMClient("memory");

  const typeSpec =
    questionType === MemoryReviewQuestionType.SINGLE_CHOICE
      ? "单选题（提供 A/B/C/D 4个选项，answer 只写正确选项的字母，如 A）"
      : questionType === MemoryReviewQuestionType.FILL_BLANK
        ? "填空题（stem 中用 _____ 标记空白，answer 是1-4个字的短语或专有名词）"
        : "判断题（stem 为一段陈述，answer 只能是 正确 或 错误）";

  const optionsInstruction =
    questionType === MemoryReviewQuestionType.SINGLE_CHOICE
      ? `"options": ["A. ...", "B. ...", "C. ...", "D. ..."],`
      : questionType === MemoryReviewQuestionType.TRUE_FALSE
        ? `"options": ["正确", "错误"],`
        : `"options": null,`;

  const prompt = `你是计算机网络课程的教师，请针对概念「${concept.conceptName}」出一道${typeSpec}。

要求：
- 题目难度适中，能快速判断学生是否掌握该概念
- explanation 简洁，不超过 80 字

严格输出以下 JSON（无多余内容）：
{
  "stem": "题干",
  ${optionsInstruction}
  "answer": "正确答案",
  "explanation": "解析"
}`;

  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const text = resp.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as {
      stem: string;
      options: string[] | null;
      answer: string;
      explanation: string;
    };
    if (!parsed.stem || !parsed.answer) return null;
    return {
      type: questionType,
      stem: parsed.stem,
      options: parsed.options ?? null,
      answer: parsed.answer,
      explanation: parsed.explanation ?? "",
      conceptName: concept.conceptName,
      conceptId: concept.conceptId,
      courseId: concept.courseId,
    };
  } catch {
    return null;
  }
}

/**
 * Generate questions for the given concepts using RAG + LLM hybrid strategy.
 */
async function generateQuestionsHybrid(
  concepts: ConceptWithCourse[],
  totalCount: number,
): Promise<RawQuestion[]> {
  const questions: RawQuestion[] = [];
  const perConcept = Math.ceil(totalCount / Math.max(concepts.length, 1));

  for (let i = 0; i < concepts.length && questions.length < totalCount; i++) {
    const concept = concepts[i];
    const needed = Math.min(perConcept, totalCount - questions.length);
    const preferredType = TYPE_CYCLE[i % TYPE_CYCLE.length];

    // RAG path: only for SINGLE_CHOICE and FILL_BLANK when a course is available
    if (
      concept.courseId &&
      preferredType !== MemoryReviewQuestionType.TRUE_FALSE
    ) {
      const ragQs = await generateViaRag(concept.courseId, needed, concept.conceptName, concept.conceptId);
      if (ragQs.length > 0) {
        questions.push(...ragQs.slice(0, needed));
        continue;
      }
    }

    // LLM fallback (also the only path for TRUE_FALSE)
    const q = await generateViaLlm(concept, preferredType);
    if (q) questions.push(q);
  }

  return questions.slice(0, totalCount);
}

// ---------------------------------------------------------------------------
// 4. Create daily session (idempotent)
// ---------------------------------------------------------------------------

export async function createDailySession(
  userId: string,
  scheduledDate: string, // "YYYY-MM-DD"
): Promise<{ sessionId: string; created: boolean }> {
  // Idempotency: skip if active session already exists for today
  const existing = await prisma.memoryReviewSession.findUnique({
    where: { userId_scheduledDate: { userId, scheduledDate } },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== MemoryReviewSessionStatus.EXPIRED) {
    return { sessionId: existing.id, created: false };
  }

  // Select concepts
  const concepts = await selectConceptsForReview(userId);
  if (concepts.length === 0) {
    return { sessionId: "", created: false };
  }

  // Generate questions
  const rawQuestions = await generateQuestionsHybrid(concepts, QUESTION_COUNT);
  if (rawQuestions.length === 0) {
    return { sessionId: "", created: false };
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  // Upsert session (handles race condition on repeated ticks)
  const session = await prisma.memoryReviewSession.upsert({
    where: { userId_scheduledDate: { userId, scheduledDate } },
    create: {
      userId,
      scheduledDate,
      status: MemoryReviewSessionStatus.PENDING,
      questionCount: rawQuestions.length,
      expiresAt,
      questions: {
        create: rawQuestions.map((q) => ({
          courseId: q.courseId,
          conceptId: q.conceptId,
          conceptName: q.conceptName,
          type: q.type,
          stem: q.stem,
          optionsJson: q.options ? q.options : undefined,
          answer: q.answer,
          explanation: q.explanation,
        })),
      },
    },
    update: {
      // If previous was EXPIRED, reset it
      status: MemoryReviewSessionStatus.PENDING,
      questionCount: rawQuestions.length,
      expiresAt,
    },
    select: { id: true },
  });

  // Push SSE notification
  await createNotification({
    userId,
    type: NotificationType.MEMORY_REVIEW_READY,
    title: "每日记忆复习",
    body: `今日为你准备了 ${rawQuestions.length} 道复习题，巩固你的知识掌握！`,
    metadata: { sessionId: session.id, questionCount: rawQuestions.length },
  });

  return { sessionId: session.id, created: true };
}

// ---------------------------------------------------------------------------
// 5. Get pending session (with lazy expiry)
// ---------------------------------------------------------------------------

export async function getPendingSession(userId: string): Promise<PendingSessionDto | null> {
  const now = new Date();

  // Find the most recent non-terminal session
  const session = await prisma.memoryReviewSession.findFirst({
    where: {
      userId,
      status: { in: [MemoryReviewSessionStatus.PENDING, MemoryReviewSessionStatus.IN_PROGRESS] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      questions: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          stem: true,
          optionsJson: true,
          conceptName: true,
          answeredAt: true,
          userAnswer: true,
          isCorrect: true,
          // Intentionally omitting: answer, explanation (revealed only on /answer response)
        },
      },
    },
  });

  if (!session) return null;

  // Lazy expiry
  if (session.expiresAt < now) {
    await prisma.memoryReviewSession.update({
      where: { id: session.id },
      data: { status: MemoryReviewSessionStatus.EXPIRED },
    });
    return null;
  }

  return {
    sessionId: session.id,
    questionCount: session.questionCount,
    answeredCount: session.questions.filter((q) => q.answeredAt !== null).length,
    expiresAt: session.expiresAt.toISOString(),
    questions: session.questions.map((q) => ({
      id: q.id,
      type: q.type,
      stem: q.stem,
      options: Array.isArray(q.optionsJson) ? (q.optionsJson as string[]) : null,
      conceptName: q.conceptName,
      answeredAt: q.answeredAt?.toISOString() ?? null,
      userAnswer: q.userAnswer,
      isCorrect: q.isCorrect,
    })),
  };
}

// ---------------------------------------------------------------------------
// 6. Answer a question (immediate grading + mastery update)
// ---------------------------------------------------------------------------

export async function answerQuestion(
  sessionId: string,
  questionId: string,
  userId: string,
  userAnswer: string,
): Promise<AnswerResult> {
  // Load question with session ownership check
  const question = await prisma.memoryReviewQuestion.findFirst({
    where: { id: questionId, sessionId },
    include: { session: { select: { userId: true, status: true } } },
  });

  if (!question || question.session.userId !== userId) {
    throw Object.assign(new Error("Question not found"), { statusCode: 404 });
  }
  if (question.answeredAt !== null) {
    throw Object.assign(new Error("Already answered"), { statusCode: 409 });
  }
  if (
    question.session.status === MemoryReviewSessionStatus.DISMISSED ||
    question.session.status === MemoryReviewSessionStatus.EXPIRED
  ) {
    throw Object.assign(new Error("Session is closed"), { statusCode: 409 });
  }

  // Grade
  const { isCorrect, correctAnswer, feedback } = gradeObjectiveAnswer(question.answer, userAnswer);

  // Update question record
  await prisma.memoryReviewQuestion.update({
    where: { id: questionId },
    data: { userAnswer, isCorrect, answeredAt: new Date() },
  });

  // Update session status
  const [, allQuestions] = await prisma.$transaction([
    prisma.memoryReviewSession.update({
      where: { id: sessionId },
      data: {
        status:
          question.session.status === MemoryReviewSessionStatus.PENDING
            ? MemoryReviewSessionStatus.IN_PROGRESS
            : undefined,
      },
    }),
    prisma.memoryReviewQuestion.findMany({
      where: { sessionId },
      select: { answeredAt: true },
    }),
  ]);

  const allAnswered = allQuestions.every((q) => q.answeredAt !== null);
  if (allAnswered) {
    await prisma.memoryReviewSession.update({
      where: { id: sessionId },
      data: { status: MemoryReviewSessionStatus.COMPLETED },
    });
  }

  // Update mastery (immediate, non-blocking)
  await updateMastery(userId, question.conceptId, question.conceptName, isCorrect);

  return { isCorrect, correctAnswer, explanation: question.explanation };
}

/** Increment or decrement mastery for the tested concept. */
async function updateMastery(
  userId: string,
  conceptId: string | null,
  conceptName: string,
  isCorrect: boolean,
): Promise<void> {
  const delta = isCorrect ? MASTERY_BUMP : -MASTERY_DROP;

  if (conceptId) {
    // Precise update by ID — safer than name matching
    const concept = await prisma.userMemoryConcept.findFirst({
      where: { id: conceptId, userId },
      select: { id: true, masteryLevel: true },
    });
    if (concept) {
      const newLevel = Math.min(1, Math.max(0, concept.masteryLevel + delta));
      await prisma.userMemoryConcept.update({
        where: { id: concept.id },
        data: { masteryLevel: newLevel },
      });
      return;
    }
  }

  // Fallback: upsert by (userId, name)
  const existing = await prisma.userMemoryConcept.findUnique({
    where: { userId_name: { userId, name: conceptName } },
    select: { id: true, masteryLevel: true },
  });
  if (existing) {
    const newLevel = Math.min(1, Math.max(0, existing.masteryLevel + delta));
    await prisma.userMemoryConcept.update({
      where: { id: existing.id },
      data: { masteryLevel: newLevel },
    });
  }
  // If concept doesn't exist (e.g. LLM invented a name not in memory), skip silently.
}

// ---------------------------------------------------------------------------
// 7. Dismiss session
// ---------------------------------------------------------------------------

export async function dismissSession(sessionId: string, userId: string): Promise<void> {
  const session = await prisma.memoryReviewSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, status: true },
  });
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  if (
    session.status === MemoryReviewSessionStatus.COMPLETED ||
    session.status === MemoryReviewSessionStatus.EXPIRED
  ) {
    return; // no-op for already-terminal sessions
  }

  await prisma.memoryReviewSession.update({
    where: { id: sessionId },
    data: { status: MemoryReviewSessionStatus.DISMISSED },
  });
  // Unanswered questions: mastery NOT updated (by design — only answeredAt triggers mastery write)
}
