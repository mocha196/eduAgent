import { after } from "next/server";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import { assertTeacherOfCourse, assertUuid, getCourseIfMember } from "@/lib/course-access";
import { getLLMClient, getMemoryModel } from "@/lib/agent/llm-registry";
import { MemoryExtractor, type SubmissionMemoryContext } from "@/lib/agent/memory/memory-extractor";
import { memoryStore } from "@/lib/agent/memory/memory-store";
import { runWithUserLlm } from "@/lib/agent/user-llm-store";
import { Prisma, SubmissionStatus, UserRole } from "@prisma/client";
import { createNotification, createBulkNotifications } from "@/lib/services/notificationService";
import {
  assertCanOverrideSubmissionGrades,
  assertCanReadStudentGrading,
  assertCanResubmitSubmission,
  assertCanReturnSubmission,
  assertCanSubmitAssignment,
} from "@/lib/domain/submission-lifecycle";
import { gradingStrategyRegistry } from "@/lib/services/grading/grading-strategies";
import { randomUUID } from "crypto";
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
  assertCanSubmitAssignment(assignment.status, assignment.deadline);

  // Check if there's an existing RETURNED submission (cannot re-submit after grading returned)
  const existing = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId, studentId } },
  });
  assertCanResubmitSubmission(existing?.status);

  const answerData = body.answers as unknown as import("@prisma/client").Prisma.InputJsonValue;
  let submission;
  if (existing) {
    // The status/version predicates close the gap between the earlier lifecycle
    // check and this write (for example, a teacher returning the grade now).
    const changed = await prisma.assignmentSubmission.updateMany({
      where: {
        id: existing.id,
        version: existing.version,
        status: { not: SubmissionStatus.RETURNED },
      },
      data: {
        answers: answerData,
        status: SubmissionStatus.SUBMITTED,
        gradingToken: null,
        version: { increment: 1 },
        gradingResult: Prisma.DbNull,
        totalScore: null,
        maxScore: null,
        teacherFeedback: null,
        submittedAt: new Date(),
        gradedAt: null,
        returnedAt: null,
      },
    });
    if (changed.count === 0) {
      throw new ApiError(409, "CONFLICT", "Submission changed; refresh and retry");
    }
    submission = await prisma.assignmentSubmission.findUnique({
      where: { id: existing.id },
      include: { student: { select: { realName: true, username: true } } },
    });
  } else {
    try {
      submission = await prisma.assignmentSubmission.create({
        data: { assignmentId, studentId, answers: answerData, status: SubmissionStatus.SUBMITTED },
        include: { student: { select: { realName: true, username: true } } },
      });
    } catch (error) {
      // A concurrent first submission may have won the unique constraint.
      if ((error as { code?: string } | null)?.code !== "P2002") throw error;
      throw new ApiError(409, "CONFLICT", "Submission was created concurrently; retry");
    }
  }
  if (!submission) throw new ApiError(409, "CONFLICT", "Submission changed; retry");

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
          dedupKey: `submission-received:${submission.id}:${submission.version}`,
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
  const gradingToken = randomUUID();
  // Atomically claim this submission. A concurrent grader observes count=0.
  const claimed = await prisma.assignmentSubmission.updateMany({
    where: { id: submissionId, status: SubmissionStatus.SUBMITTED },
    data: {
      status: SubmissionStatus.GRADING,
      gradingToken,
      version: { increment: 1 },
    },
  });
  if (claimed.count === 0) return;

  const submission = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, status: SubmissionStatus.GRADING, gradingToken },
    include: { assignment: true },
  });
  // A re-submission may have invalidated the claim between claim and fetch.
  if (!submission) return;

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
        const strategy = gradingStrategyRegistry.get(question.type);
        grades.push(await strategy.grade(question, studentAnswer));
      }
      return grades;
    }, // end runWithUserLlm
  );

  const totalScore = questionGrades.reduce((s, g) => s + g.score, 0);
  const maxScore = questionGrades.reduce((s, g) => s + g.maxScore, 0);

  const gradingResult: GradingResultDto = { totalScore, maxScore, questionGrades };

  // Commit only if this attempt still owns the row. Re-submission clears the
  // token, while return/other lifecycle changes alter the status.
  await prisma.assignmentSubmission.updateMany({
    where: { id: submissionId, status: SubmissionStatus.GRADING, gradingToken },
    data: {
      status: SubmissionStatus.GRADED,
      gradingToken: null,
      version: { increment: 1 },
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
  } else {
    assertCanReadStudentGrading(row.status);
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
  assertCanOverrideSubmissionGrades(row.status);

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

  const changed = await prisma.assignmentSubmission.updateMany({
    where: {
      id: submissionId,
      version: row.version,
      status: { in: [SubmissionStatus.GRADED, SubmissionStatus.RETURNED] },
    },
    data: {
      gradingResult: updated as unknown as import("@prisma/client").Prisma.InputJsonValue,
      totalScore,
      teacherFeedback: body.teacherFeedback ?? row.teacherFeedback,
      version: { increment: 1 },
    },
  });
  if (changed.count === 0) {
    throw new ApiError(409, "CONFLICT", "Submission changed; refresh and retry");
  }
  const saved = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!saved) throw new ApiError(404, "NOT_FOUND", "Submission not found");
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
  assertCanReturnSubmission(row.status);

  const changed = await prisma.assignmentSubmission.updateMany({
    where: {
      id: submissionId,
      status: { in: [SubmissionStatus.GRADED, SubmissionStatus.RETURNED] },
      version: row.version,
    },
    data: {
      status: SubmissionStatus.RETURNED,
      gradingToken: null,
      returnedAt: new Date(),
      version: { increment: 1 },
    },
  });
  if (changed.count === 0) {
    throw new ApiError(409, "CONFLICT", "Submission changed; refresh and retry");
  }
  const saved = await prisma.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    include: { student: { select: { realName: true, username: true } } },
  });
  if (!saved) throw new ApiError(404, "NOT_FOUND", "Submission not found");

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
          dedupKey: `grade-returned:${submissionId}`,
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
    data: {
      status: SubmissionStatus.RETURNED,
      gradingToken: null,
      returnedAt: new Date(),
      version: { increment: 1 },
    },
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
        dedupKey: `grade-returned:${assignmentId}`,
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
