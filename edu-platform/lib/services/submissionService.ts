import { after } from "next/server";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import { assertTeacherOfCourse, assertUuid, getCourseIfMember } from "@/lib/course-access";
import { getLLMClient, getRoleConfig, getMemoryModel } from "@/lib/agent/llm-registry";
import { MemoryExtractor, type SubmissionMemoryContext } from "@/lib/agent/memory/memory-extractor";
import { memoryStore } from "@/lib/agent/memory/memory-store";
import { runWithUserLlm } from "@/lib/agent/user-llm-store";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "@/lib/agent/tracing/langfuse-tracer";
import { AssignmentStatus, SubmissionStatus, UserRole } from "@prisma/client";
import { createNotification, createBulkNotifications } from "@/lib/services/notificationService";
import type {
  GradingResultDto,
  OverrideGradesBody,
  QuestionGradeItem,
  StudentAnswerItem,
  SubmissionDetailDto,
  SubmissionSummaryDto,
} from "@/lib/dto/submission.dto";
import type { QuestionItem } from "@/lib/dto/assignment.dto";

// ── Private helpers ──────────────────────────────────────────────────────────

function toSummary(row: {
  id: string;
  assignmentId: string;
  studentId: string;
  student: { realName: string | null; username: string } | null;
  status: SubmissionStatus;
  gradingResult: unknown;
  totalScore: number | null;
  maxScore: number | null;
  submittedAt: Date;
  gradedAt: Date | null;
  returnedAt: Date | null;
}): SubmissionSummaryDto {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    studentId: row.studentId,
    studentName: row.student?.realName ?? row.student?.username ?? null,
    status: row.status,
    totalScore: row.totalScore ?? null,
    maxScore: row.maxScore ?? null,
    submittedAt: row.submittedAt.toISOString(),
    gradedAt: row.gradedAt?.toISOString() ?? null,
    returnedAt: row.returnedAt?.toISOString() ?? null,
  };
}

function toDetail(row: {
  id: string;
  assignmentId: string;
  studentId: string;
  student: { realName: string | null; username: string } | null;
  status: SubmissionStatus;
  answers: unknown;
  gradingResult: unknown;
  totalScore: number | null;
  maxScore: number | null;
  teacherFeedback: string | null;
  submittedAt: Date;
  gradedAt: Date | null;
  returnedAt: Date | null;
}): SubmissionDetailDto {
  return {
    ...toSummary(row),
    answers: (row.answers as StudentAnswerItem[]) ?? [],
    gradingResult: (row.gradingResult as GradingResultDto) ?? null,
    teacherFeedback: row.teacherFeedback,
  };
}

/** Auto-grade objective questions (single/multi choice). All-or-nothing. */
function gradeObjective(question: QuestionItem, studentAnswer: string): QuestionGradeItem {
  const correct =
    studentAnswer.trim().toLowerCase() === question.answer.trim().toLowerCase();
  return {
    questionId: question.id,
    score: correct ? question.score : 0,
    maxScore: question.score,
    isCorrect: correct,
    feedback: correct ? "回答正确。" : `正确答案为：${question.answer}`,
    source: "AUTO",
    correctAnswer: question.answer,
  };
}

/** AI-grade subjective questions (fill_blank / short_answer) via LLM_AUXILIARY_MODEL. */
async function gradeSubjective(
  question: QuestionItem,
  studentAnswer: string,
): Promise<QuestionGradeItem> {
  const config = getRoleConfig("grading");
  const client = getLLMClient("grading");
  const trace = createStandaloneTrace({
    name: "teaching.grade_subjective",
    metadata: { questionId: question.id, type: question.type, model: config.model },
  });

  const prompt = `你是一位严谨的教育工作者，请根据以下信息对学生答案进行评分。

题目：${question.question}
题型：${question.type === "fill_blank" ? "填空题" : "简答题"}
参考答案：${question.answer}
答案解析：${question.explanation}
满分：${question.score}分

学生答案：${studentAnswer}

请按以下JSON格式返回评分结果（不要包含其他内容）：
{"score": <0到${question.score}之间的数字>, "feedback": "<简洁的中文评语，说明得分原因>"}`;

  try {
    const resp = await client.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 256,
    });
    const raw = resp.choices[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { score: number; feedback: string };
      const score = Math.max(0, Math.min(question.score, Number(parsed.score) || 0));
      recordGeneration(trace, {
        name: "grade_subjective_llm",
        model: config.model,
        input: [{ role: "user", content: prompt }],
        output: { score, feedback: parsed.feedback },
        usage: {
          promptTokens: resp.usage?.prompt_tokens,
          completionTokens: resp.usage?.completion_tokens,
          totalTokens: resp.usage?.total_tokens,
        },
      });
      void flushLangfuse();
      return {
        questionId: question.id,
        score,
        maxScore: question.score,
        isCorrect: score >= question.score,
        feedback: parsed.feedback ?? "",
        source: "AI",
        correctAnswer: question.answer,
      };
    }
  } catch {
    // Fall through to partial-credit fallback
  }

  // Fallback: give half credit
  return {
    questionId: question.id,
    score: Math.floor(question.score / 2),
    maxScore: question.score,
    isCorrect: null,
    feedback: "AI 评分失败，已给予参考分值，请教师手动复核。",
    source: "AI",
    correctAnswer: question.answer,
  };
}

// ── Public service functions ─────────────────────────────────────────────────

/** Student submits (or re-submits before deadline) answers for a published assignment. */
export async function submitAssignment(
  studentId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  body: { answers: StudentAnswerItem[] },
): Promise<SubmissionDetailDto> {
  assertUuid(courseId, "course_id");
  assertUuid(assignmentId, "assignment_id");

  if (role !== UserRole.STUDENT) {
    throw new ApiError(403, "FORBIDDEN", "Only students can submit assignments");
  }
  await getCourseIfMember(studentId, role, courseId);

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId },
  });
  if (!assignment) throw new ApiError(404, "NOT_FOUND", "Assignment not found");
  if (assignment.status !== AssignmentStatus.PUBLISHED) {
    throw new ApiError(400, "NOT_PUBLISHED", "Assignment is not published");
  }
  if (assignment.deadline && new Date() > assignment.deadline) {
    throw new ApiError(403, "DEADLINE_PASSED", "Submission deadline has passed");
  }

  // Check if there's an existing RETURNED submission (cannot re-submit after grading returned)
  const existing = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId, studentId } },
  });
  if (existing?.status === SubmissionStatus.RETURNED) {
    throw new ApiError(409, "ALREADY_RETURNED", "Your submission has already been returned; re-submission is not allowed");
  }

  const submission = await prisma.assignmentSubmission.upsert({
    where: { assignmentId_studentId: { assignmentId, studentId } },
    create: {
      assignmentId,
      studentId,
      answers: body.answers as unknown as import("@prisma/client").Prisma.InputJsonValue,
      status: SubmissionStatus.SUBMITTED,
    },
    update: {
      answers: body.answers as unknown as import("@prisma/client").Prisma.InputJsonValue,
      status: SubmissionStatus.SUBMITTED,
      gradingResult: undefined,
      teacherFeedback: null,
      gradedAt: null,
      returnedAt: null,
    },
    include: { student: { select: { realName: true, username: true } } },
  });

  // Trigger AI grading asynchronously after response is sent
  after(async () => {
    try {
      await triggerGrading(submission.id);
    } catch {
      // Grading failure is non-fatal; teacher can re-trigger manually
    }
  });

  // Notify the course teacher that a student has submitted
  void (async () => {
    try {
      const course = await prisma.course.findFirst({
        where: { id: courseId },
        select: { teacherId: true, name: true },
      });
      if (course) {
        const studentName =
          submission.student?.realName ?? submission.student?.username ?? "学生";
        void createNotification({
          userId: course.teacherId,
          type: "SUBMISSION_RECEIVED",
          title: "学生提交了作业",
          body: `${studentName} 提交了《${assignment.title}》的作业。`,
          metadata: { courseId, assignmentId, submissionId: submission.id, courseName: course.name },
        });
      }
    } catch {
      // Best-effort
    }
  })();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toDetail(submission as any);
}

/** Trigger AI grading for a submission (idempotent). */
export async function triggerGrading(submissionId: string): Promise<void> {
  const submission = await prisma.assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: { assignment: true },
  });
  if (!submission) return;
  if (submission.status === SubmissionStatus.RETURNED) return;

  // Mark as GRADING
  await prisma.assignmentSubmission.update({
    where: { id: submissionId },
    data: { status: SubmissionStatus.GRADING },
  });

  const questions = Array.isArray(submission.assignment.questions)
    ? (submission.assignment.questions as unknown as QuestionItem[])
    : [];
  const answers = submission.answers as unknown as StudentAnswerItem[];

  const questionGrades: QuestionGradeItem[] = await runWithUserLlm(
    submission.studentId,
    async () => {
  const grades: QuestionGradeItem[] = [];

  for (const question of questions) {
    const studentAnswer =
      answers.find((a) => a.questionId === question.id)?.answer ?? "";

    if (
      question.type === "single_choice" ||
      question.type === "multi_choice"
    ) {
      grades.push(gradeObjective(question, studentAnswer));
    } else {
      grades.push(await gradeSubjective(question, studentAnswer));
    }
  }
  return grades;
  }, // end runWithUserLlm
  );

  const totalScore = questionGrades.reduce((s, g) => s + g.score, 0);
  const maxScore = questionGrades.reduce((s, g) => s + g.maxScore, 0);

  const gradingResult: GradingResultDto = { totalScore, maxScore, questionGrades };

  await prisma.assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      status: SubmissionStatus.GRADED,
      gradingResult: gradingResult as unknown as import("@prisma/client").Prisma.InputJsonValue,
      totalScore,
      maxScore,
      gradedAt: new Date(),
    },
  });

}

/** Student retrieves their own submission (answers visible; grading only after RETURNED). */
export async function getMySubmission(
  studentId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<SubmissionDetailDto | null> {
  assertUuid(courseId, "course_id");
  assertUuid(assignmentId, "assignment_id");

  if (role !== UserRole.STUDENT) {
    throw new ApiError(403, "FORBIDDEN", "Student role required");
  }
  await getCourseIfMember(studentId, role, courseId);

  const row = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId, studentId } },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!row) return null;

  const detail = toDetail(row);
  // Hide grading details until returned
  if (row.status !== SubmissionStatus.RETURNED) {
    detail.gradingResult = null;
    detail.teacherFeedback = null;
  }
  return detail;
}

/** Teacher lists all submissions for an assignment. */
export async function listSubmissionsForTeacher(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<{
  submissions: SubmissionSummaryDto[];
  stats: { total: number; graded: number; returned: number; avgScore: number | null };
}> {
  assertUuid(courseId, "course_id");
  assertUuid(assignmentId, "assignment_id");
  await assertTeacherOfCourse(teacherId, role, courseId);

  const rows = await prisma.assignmentSubmission.findMany({
    where: { assignmentId },
    include: { student: { select: { realName: true, username: true } } },
    orderBy: { submittedAt: "desc" },
  });

  const summaries = rows.map(toSummary);

  const graded = summaries.filter(
    (s) => s.status === SubmissionStatus.GRADED || s.status === SubmissionStatus.RETURNED,
  ).length;
  const returned = summaries.filter((s) => s.status === SubmissionStatus.RETURNED).length;
  const scores = summaries
    .filter((s) => s.totalScore !== null)
    .map((s) => s.totalScore as number);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  return {
    submissions: summaries,
    stats: { total: rows.length, graded, returned, avgScore },
  };
}

/** Teacher views full detail of a single submission. */
export async function getSubmissionDetail(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  submissionId: string,
): Promise<SubmissionDetailDto> {
  assertUuid(submissionId, "submission_id");
  await assertTeacherOfCourse(teacherId, role, courseId);

  const row = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Submission not found");
  return toDetail(row);
}

/** Teacher overrides AI-generated grades for a submission. */
export async function overrideGrades(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  body: OverrideGradesBody,
): Promise<SubmissionDetailDto> {
  assertUuid(submissionId, "submission_id");
  await assertTeacherOfCourse(teacherId, role, courseId);

  const row = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Submission not found");
  if (
    row.status !== SubmissionStatus.GRADED &&
    row.status !== SubmissionStatus.RETURNED
  ) {
    throw new ApiError(400, "NOT_GRADED", "Submission has not been graded yet");
  }

  const existing = (row.gradingResult as unknown as GradingResultDto) ?? {
    totalScore: 0,
    maxScore: 0,
    questionGrades: [],
  };

  // Apply overrides
  const overrideMap = new Map(body.questionGrades.map((g) => [g.questionId, g]));
  const updatedGrades = existing.questionGrades.map((qg) => {
    const override = overrideMap.get(qg.questionId);
    if (!override) return qg;
    return {
      ...qg,
      score: override.score,
      feedback: override.feedback ?? qg.feedback,
      source: "TEACHER" as const,
    };
  });

  const totalScore = updatedGrades.reduce((s, g) => s + g.score, 0);
  const updated: GradingResultDto = {
    ...existing,
    totalScore,
    questionGrades: updatedGrades,
  };

  const saved = await prisma.assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      gradingResult: updated as unknown as import("@prisma/client").Prisma.InputJsonValue,
      totalScore,
      teacherFeedback: body.teacherFeedback ?? row.teacherFeedback,
    },
    include: { student: { select: { realName: true, username: true } } },
  });
  return toDetail(saved);
}

/** Return a single graded submission to the student. */
export async function returnSubmission(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
  submissionId: string,
): Promise<SubmissionDetailDto> {
  assertUuid(submissionId, "submission_id");
  await assertTeacherOfCourse(teacherId, role, courseId);

  const row = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Submission not found");
  if (row.status !== SubmissionStatus.GRADED && row.status !== SubmissionStatus.RETURNED) {
    throw new ApiError(400, "NOT_GRADED", "Submission must be in GRADED status to return");
  }

  const saved = await prisma.assignmentSubmission.update({
    where: { id: submissionId },
    data: { status: SubmissionStatus.RETURNED, returnedAt: new Date() },
    include: { student: { select: { realName: true, username: true } } },
  });

  // Notify the student and extract memory facts now that teacher has reviewed (non-blocking)
  void (async () => {
    try {
      const assignment = await prisma.assignment.findFirst({
        where: { id: assignmentId },
        select: { title: true, questions: true, course: { select: { name: true } } },
      });
      if (assignment) {
        void createNotification({
          userId: row.studentId,
          type: "GRADE_RETURNED",
          title: "成绩已返回",
          body: `《${assignment.title}》的批改结果已发布，请查看。`,
          metadata: { courseId, assignmentId, submissionId, courseName: assignment.course.name },
        });
      }
    } catch {
      // Best-effort
    }
  })();

  // Asynchronously extract memory facts after teacher review (non-blocking)
  void (async () => {
    try {
      const assignment = await prisma.assignment.findFirst({
        where: { id: assignmentId },
        select: { questions: true, title: true },
      });
      if (!assignment) return;
      const questions = Array.isArray(assignment.questions)
        ? (assignment.questions as unknown as QuestionItem[])
        : [];
      const answers = row.answers as unknown as StudentAnswerItem[];
      const gradingResult = (row.gradingResult as unknown as GradingResultDto) ?? {
        totalScore: 0,
        maxScore: 0,
        questionGrades: [],
      };
      const memoryCtx: SubmissionMemoryContext = {
        assignmentTitle: assignment.title,
        totalScore: gradingResult.totalScore,
        maxScore: gradingResult.maxScore,
        questions: questions.map((q) => {
          const grade = gradingResult.questionGrades.find((g) => g.questionId === q.id);
          const studentAnswer = answers.find((a) => a.questionId === q.id)?.answer ?? "";
          return {
            stem: q.question,
            type: q.type,
            entities: q.entities ?? [],
            studentAnswer,
            score: grade?.score ?? 0,
            maxScore: q.score,
            isCorrect: grade?.isCorrect ?? null,
            feedback: grade?.feedback ?? "",
            correctAnswer: q.answer,
          };
        }),
      };
      const extractor = new MemoryExtractor(getLLMClient("memory"), getMemoryModel());
      const facts = await extractor.extractFactsFromSubmission(
        row.studentId,
        submissionId,
        memoryCtx,
      );
      for (const fact of facts) {
        await memoryStore.addFact(fact);
      }
    } catch (err) {
      console.error("[returnSubmission] memory extraction failed:", err);
    }
  })();

  return toDetail(saved);
}

/** Batch-return all GRADED submissions for an assignment. */
export async function batchReturnSubmissions(
  teacherId: string,
  role: UserRole,
  courseId: string,
  assignmentId: string,
): Promise<{ returnedCount: number }> {
  assertUuid(assignmentId, "assignment_id");
  await assertTeacherOfCourse(teacherId, role, courseId);

  // Collect submission data before updating (updateMany doesn't return rows)
  const toReturn = await prisma.assignmentSubmission.findMany({
    where: { assignmentId, status: SubmissionStatus.GRADED },
    select: { id: true, studentId: true, gradingResult: true, answers: true },
  });

  const result = await prisma.assignmentSubmission.updateMany({
    where: { assignmentId, status: SubmissionStatus.GRADED },
    data: { status: SubmissionStatus.RETURNED, returnedAt: new Date() },
  });

  // Notify each student and extract memory facts asynchronously
  void (async () => {
    try {
      const assignment = await prisma.assignment.findFirst({
        where: { id: assignmentId },
        select: { title: true, questions: true, course: { select: { name: true } } },
      });
      if (!assignment || toReturn.length === 0) return;
      const studentIds = toReturn.map((s) => s.studentId);
      void createBulkNotifications({
        userIds: studentIds,
        type: "GRADE_RETURNED",
        title: "成绩已返回",
        body: `《${assignment.title}》的批改结果已发布，请查看。`,
        metadata: { courseId, assignmentId, courseName: assignment.course.name },
      });
      const questions = Array.isArray(assignment.questions)
        ? (assignment.questions as unknown as QuestionItem[])
        : [];
      const extractor = new MemoryExtractor(getLLMClient("memory"), getMemoryModel());
      for (const sub of toReturn) {
        try {
          const answers = sub.answers as unknown as StudentAnswerItem[];
          const gradingResult = (sub.gradingResult as unknown as GradingResultDto) ?? {
            totalScore: 0,
            maxScore: 0,
            questionGrades: [],
          };
          const memoryCtx: SubmissionMemoryContext = {
            assignmentTitle: assignment.title,
            totalScore: gradingResult.totalScore,
            maxScore: gradingResult.maxScore,
            questions: questions.map((q) => {
              const grade = gradingResult.questionGrades.find((g) => g.questionId === q.id);
              const studentAnswer = answers.find((a) => a.questionId === q.id)?.answer ?? "";
              return {
                stem: q.question,
                type: q.type,
                entities: q.entities ?? [],
                studentAnswer,
                score: grade?.score ?? 0,
                maxScore: q.score,
                isCorrect: grade?.isCorrect ?? null,
                feedback: grade?.feedback ?? "",
                correctAnswer: q.answer,
              };
            }),
          };
          const facts = await extractor.extractFactsFromSubmission(
            sub.studentId,
            sub.id,
            memoryCtx,
          );
          for (const fact of facts) {
            await memoryStore.addFact(fact);
          }
        } catch (err) {
          console.error("[batchReturnSubmissions] memory extraction failed for", sub.id, err);
        }
      }
    } catch {
      // Best-effort
    }
  })();

  return { returnedCount: result.count };
}
