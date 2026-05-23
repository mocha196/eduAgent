import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { ApiError } from "@/lib/http/api-error";
import { assertTeacherOfCourse, assertUuid, getCourseIfMember } from "@/lib/course-access";
import { createNotification, createBulkNotifications } from "@/lib/services/notificationService";

import { AssignmentStatus, UserRole } from "@prisma/client";
import type {
  AssignmentDetailDto,
  AssignmentStudentViewDto,
  AssignmentSummaryDto,
  Blueprint,
  CompleteQuestionBody,
  GenerateAssignmentBody,
  PatchAssignmentBody,
  QualityReport,
  QuestionItem,
  RegenerateQuestionBody,
  StudentQuestionItem,
} from "@/lib/dto/assignment.dto";

const STREAM_NAME = process.env.RAG_TASK_STREAM_NAME ?? "edu:rag:tasks:stream";

// ── Private helpers ─────────────────────────────────────────────────────────

function toSummary(a: {
  id: string;
  title: string;
  status: AssignmentStatus;
  questions: unknown;
  qualityReport: unknown;
  deadline: Date | null;
  createdAt: Date;
  errorMessage: string | null;
  generationPhase?: string | null;
}): AssignmentSummaryDto {
  const qs = Array.isArray(a.questions) ? (a.questions as QuestionItem[]) : null;
  const qr = a.qualityReport ? (a.qualityReport as QualityReport) : null;
  return {
    id: a.id,
    title: a.title,
    status: a.status,
    questionCount: qs?.length ?? 0,
    qualityScore: qr?.overall_score ?? null,
    deadline: a.deadline?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    errorMessage: a.errorMessage,
    generationPhase: a.generationPhase ?? null,
  };
}

function toDetail(a: {
  id: string;
  title: string;
  description: string | null;
  status: AssignmentStatus;
  questions: unknown;
  blueprint: unknown;
  qualityReport: unknown;
  deadline: Date | null;
  createdAt: Date;
  publishedAt: Date | null;
  errorMessage: string | null;
  teacherRequest: string | null;
  structuredParams: unknown;
}): AssignmentDetailDto {
  const summary = toSummary(a);
  return {
    ...summary,
    description: a.description,
    blueprint: a.blueprint ? (a.blueprint as Blueprint) : null,
    questions: a.questions ? (a.questions as QuestionItem[]) : null,
    qualityReport: a.qualityReport ? (a.qualityReport as QualityReport) : null,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    teacherRequest: a.teacherRequest,
    structuredParams: a.structuredParams ? (a.structuredParams as import("@/lib/dto/assignment.dto").StructuredGenerationParams) : null,
  };
}

// ── Public service functions ─────────────────────────────────────────────────

export async function listAssignments(
  teacherId: string,
  role: UserRole,
  courseId: string,
): Promise<AssignmentSummaryDto[]> {
  await assertTeacherOfCourse(teacherId, role, courseId);
  const rows = await prisma.assignment.findMany({
    where: { courseId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      questions: true,
      qualityReport: true,
      deadline: true,
      createdAt: true,
      errorMessage: true,
      generationPhase: true,
    },
  });
  return rows.map(toSummary);
}

export async function getAssignment(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<AssignmentDetailDto> {
  await assertTeacherOfCourse(teacherId, role, courseId);
  assertUuid(assignmentId, "assignment_id");
  const a = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId },
  });
  if (!a) throw new ApiError(404, "NOT_FOUND", "Assignment not found");
  return toDetail(a);
}

export async function triggerAssignmentGeneration(
  teacherId: string,
  role: UserRole,
  courseId: string,
  body: GenerateAssignmentBody,
): Promise<AssignmentSummaryDto> {
  await assertTeacherOfCourse(teacherId, role, courseId);

  if (!body.title?.trim())
    throw new ApiError(400, "VALIDATION_ERROR", "title is required");
  if (!body.teacherRequest?.trim())
    throw new ApiError(400, "VALIDATION_ERROR", "teacherRequest is required");

  const assignment = await prisma.assignment.create({
    data: {
      courseId,
      createdBy: teacherId,
      title: body.title.trim(),
      status: AssignmentStatus.GENERATING,
      deadline: body.deadline ? new Date(body.deadline) : null,
      teacherRequest: body.teacherRequest.trim(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structuredParams: body.structuredParams ? (body.structuredParams as any) : undefined,
    },
    select: {
      id: true,
      title: true,
      status: true,
      questions: true,
      qualityReport: true,
      deadline: true,
      createdAt: true,
      errorMessage: true,
      generationPhase: true,
    },
  });

  // Push task to Redis Stream (same stream as RAG worker)
  try {
    const redis = await getRedis();
    await redis.xAdd(STREAM_NAME, "*", {
      operation: "assignment.generate",
      assignment_id: assignment.id,
      course_id: courseId,
      teacher_request: body.teacherRequest.trim(),
      structured_params: body.structuredParams ? JSON.stringify(body.structuredParams) : "",
    });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    // Roll back DB record if we can't push to Redis
    await prisma.assignment.delete({ where: { id: assignment.id } }).catch(() => {});
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Could not queue assignment generation. Is the Redis stream running?",
    );
  }

  return toSummary(assignment);
}

export async function patchAssignment(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  body: PatchAssignmentBody,
): Promise<AssignmentDetailDto> {
  await assertTeacherOfCourse(teacherId, role, courseId);
  assertUuid(assignmentId, "assignment_id");

  const existing = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Assignment not found");
  if (existing.status !== AssignmentStatus.DRAFT)
    throw new ApiError(409, "CONFLICT", "Only DRAFT assignments can be edited");

  const updated = await prisma.assignment.update({
    where: { id: assignmentId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.deadline !== undefined && {
        deadline: body.deadline ? new Date(body.deadline) : null,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(body.questions !== undefined && { questions: body.questions as any }),
    },
  });
  return toDetail(updated);
}

export async function publishAssignment(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<AssignmentDetailDto> {
  await assertTeacherOfCourse(teacherId, role, courseId);
  assertUuid(assignmentId, "assignment_id");

  const existing = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Assignment not found");
  if (existing.status !== AssignmentStatus.DRAFT)
    throw new ApiError(409, "CONFLICT", "Only DRAFT assignments can be published");

  const updated = await prisma.assignment.update({
    where: { id: assignmentId },
    data: {
      status: AssignmentStatus.PUBLISHED,
      publishedAt: new Date(),
    },
  });

  // Best-effort: notify teacher + enrolled students asynchronously.
  void (async () => {
    try {
      const course = await prisma.course.findFirst({
        where: { id: courseId },
        select: { name: true, enrollments: { select: { studentId: true } } },
      });
      if (!course) return;
      const studentIds = course.enrollments.map((e) => e.studentId);
      const meta = { courseId, assignmentId, courseName: course.name };
      void createNotification({
        userId: teacherId,
        type: "ASSIGNMENT_PUBLISHED",
        title: "作业已发布",
        body: `《${updated.title}》已成功发布。`,
        metadata: meta,
      });
      if (studentIds.length > 0) {
        void createBulkNotifications({
          userIds: studentIds,
          type: "ASSIGNMENT_PUBLISHED",
          title: "新作业已发布",
          body: `《${course.name}》有新作业《${updated.title}》，请尽快完成。`,
          metadata: meta,
        });
      }
    } catch {
      // Non-fatal
    }
  })();

  return toDetail(updated);
}

export async function regenerateQuestion(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  body: RegenerateQuestionBody,
): Promise<QuestionItem> {
  const assignment = await getAssignment(teacherId, role, courseId, assignmentId);
  if (assignment.status !== AssignmentStatus.DRAFT)
    throw new ApiError(409, "CONFLICT", "Can only regenerate questions for DRAFT assignments");

  const ragBase = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/+$/, "");
  const ragKey = process.env.RAG_SERVICE_API_KEY?.trim();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ragKey) headers.set("x-internal-key", ragKey);

  const res = await fetch(`${ragBase}/rag/assignment/regenerate-question`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      course_id: courseId,
      entity_names: body.entityNames,
      q_type: body.qType,
      objective: body.objective,
      q_id: body.qId,
      extra_requirements: body.extraRequirements ?? "",
      current_question: body.currentQuestion ?? "",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(502, "AGENT_CHAT_FAILED", `Agent regenerate failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const newQuestion = (await res.json()) as QuestionItem;

  // Update the questions array in DB atomically
  const questions = (assignment.questions ?? []) as QuestionItem[];
  const updated = questions.map((q) => (q.id === body.qId ? { ...newQuestion, score: q.score } : q));
  // If question id not found (new question), append it
  if (!updated.find((q) => q.id === body.qId)) updated.push({ ...newQuestion, score: 5 });

  await prisma.assignment.update({
    where: { id: assignmentId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { questions: updated as any },
  });

  return newQuestion;
}

/**
 * Merges teacher-supplied hints into a single answer_hint string for the RAG service.
 * Pre-filled options and correct answer are appended so the LLM can use them
 * when it only needs to generate explanation (not re-derive the answer).
 */
function buildAnswerHint(body: Pick<CompleteQuestionBody, "answerHint" | "prefilledOptions" | "prefilledAnswer">): string {
  const parts: string[] = [];
  if (body.answerHint?.trim()) parts.push(body.answerHint.trim());
  const LABELS = ["A", "B", "C", "D"];
  if (body.prefilledOptions?.some((o) => o.trim())) {
    const optStr = body.prefilledOptions
      .map((o, i) => `${LABELS[i] ?? i + 1}. ${o}`)
      .join("  ");
    parts.push(`选项：${optStr}`);
  }
  if (body.prefilledAnswer?.trim()) {
    parts.push(`正确答案：${body.prefilledAnswer.trim()}`);
  }
  return parts.join("\n");
}

/** Preview-only: call AI to complete a teacher question without writing to DB. */
export async function previewTeacherQuestion(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  body: Omit<CompleteQuestionBody, "score">,
): Promise<QuestionItem> {
  const assignment = await getAssignment(teacherId, role, courseId, assignmentId);
  if (assignment.status !== AssignmentStatus.DRAFT)
    throw new ApiError(409, "CONFLICT", "Can only preview questions for DRAFT assignments");

  const ragBase = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/+$/, "");
  const ragKey = process.env.RAG_SERVICE_API_KEY?.trim();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ragKey) headers.set("x-internal-key", ragKey);

  const res = await fetch(`${ragBase}/rag/assignment/complete-question`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      course_id: courseId,
      entity_names: body.entityNames,
      question_stem: body.questionStem,
      answer_hint: buildAnswerHint(body),
      q_type: body.qType,
      objective: body.objective,
      q_id: 0, // temporary, not saved
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(502, "AGENT_CHAT_FAILED", `Agent preview failed: ${res.status} ${text.slice(0, 200)}`);
  }

  return (await res.json()) as QuestionItem;
}

export async function completeTeacherQuestion(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  body: CompleteQuestionBody,
): Promise<QuestionItem> {
  const assignment = await getAssignment(teacherId, role, courseId, assignmentId);
  if (assignment.status !== AssignmentStatus.DRAFT)
    throw new ApiError(409, "CONFLICT", "Can only add questions to DRAFT assignments");

  const ragBase = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/+$/, "");
  const ragKey = process.env.RAG_SERVICE_API_KEY?.trim();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ragKey) headers.set("x-internal-key", ragKey);

  // Allocate a new question ID (max existing + 1)
  const questions = (assignment.questions ?? []) as QuestionItem[];
  const newQId = questions.length > 0 ? Math.max(...questions.map((q) => q.id)) + 1 : 1;

  const res = await fetch(`${ragBase}/rag/assignment/complete-question`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      course_id: courseId,
      entity_names: body.entityNames,
      question_stem: body.questionStem,
      answer_hint: buildAnswerHint(body),
      q_type: body.qType,
      objective: body.objective,
      q_id: newQId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(502, "AGENT_CHAT_FAILED", `Agent complete-question failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const newQuestion = (await res.json()) as QuestionItem;
  const score = body.score ?? 5;
  const appended = [...questions, { ...newQuestion, score }];

  await prisma.assignment.update({
    where: { id: assignmentId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { questions: appended as any },
  });

  return { ...newQuestion, score };
}

// ── Student-facing helpers ───────────────────────────────────────────────────

/** List PUBLISHED assignments visible to an enrolled student. */
export async function listPublishedAssignments(
  studentId: string,
  role: UserRole,
  courseId: string,
): Promise<AssignmentSummaryDto[]> {
  await getCourseIfMember(studentId, role, courseId);
  const rows = await prisma.assignment.findMany({
    where: { courseId, status: AssignmentStatus.PUBLISHED },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      questions: true,
      qualityReport: true,
      deadline: true,
      createdAt: true,
      errorMessage: true,
    },
  });

  // Fetch this student's submission statuses in one query
  const submissions = await prisma.assignmentSubmission.findMany({
    where: { assignmentId: { in: rows.map((r) => r.id) }, studentId },
    select: { assignmentId: true, status: true },
  });
  const submissionStatusMap = new Map(submissions.map((s) => [s.assignmentId, s.status as string]));

  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    questionCount: Array.isArray(a.questions) ? (a.questions as unknown[]).length : 0,
    qualityScore: null,
    deadline: a.deadline?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    errorMessage: null,
    mySubmissionStatus: submissionStatusMap.get(a.id) ?? null,
  }));
}

/** Return a PUBLISHED assignment for a student — answers & explanations are redacted. */
export async function getAssignmentForStudent(
  studentId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<AssignmentStudentViewDto> {
  assertUuid(assignmentId, "assignment_id");
  await getCourseIfMember(studentId, role, courseId);

  const a = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId, status: AssignmentStatus.PUBLISHED },
  });
  if (!a) throw new ApiError(404, "NOT_FOUND", "Assignment not found");

  const questions = Array.isArray(a.questions)
    ? (a.questions as unknown as QuestionItem[]).map<StudentQuestionItem>((q) => ({
        ...q,
        answer: null,
        explanation: null,
      }))
    : null;

  const totalScore = Array.isArray(a.questions)
    ? (a.questions as unknown as QuestionItem[]).reduce((s, q) => s + (q.score ?? 0), 0)
    : 0;

  return {
    id: a.id,
    title: a.title,
    description: a.description,
    deadline: a.deadline?.toISOString() ?? null,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    questions,
    totalScore,
  };
}
