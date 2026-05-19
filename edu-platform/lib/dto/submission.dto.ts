import type { SubmissionStatus } from "@prisma/client";

export type { SubmissionStatus };

export type GradeSource = "AUTO" | "AI" | "TEACHER";

// ── Request bodies ──────────────────────────────────────────────────────────

export interface StudentAnswerItem {
  questionId: number;
  answer: string;
}

export interface SubmitAssignmentBody {
  answers: StudentAnswerItem[];
}

export interface OverrideGradesBody {
  /** Partial overrides — only supplied questionIds are updated. */
  questionGrades: Array<{
    questionId: number;
    score: number;
    feedback?: string;
  }>;
  teacherFeedback?: string;
}

export interface SuggestFeedbackBody {
  /** Text the teacher has typed so far (the prefix to continue). */
  prefix: string;
  questionText: string;
  studentAnswer: string;
  /** Score the teacher assigned (for context). */
  score: number;
  maxScore: number;
}

// ── Inner types ─────────────────────────────────────────────────────────────

export interface QuestionGradeItem {
  questionId: number;
  score: number;
  maxScore: number;
  isCorrect: boolean | null;
  feedback: string;
  source: GradeSource;
  /** Stored at grading time so students can see the correct answer after RETURNED. */
  correctAnswer?: string;
}

export interface GradingResultDto {
  totalScore: number;
  maxScore: number;
  questionGrades: QuestionGradeItem[];
}

// ── Response DTOs ───────────────────────────────────────────────────────────

export interface SubmissionSummaryDto {
  id: string;
  assignmentId: string;
  studentId: string;
  studentName: string | null;
  status: SubmissionStatus;
  totalScore: number | null;
  maxScore: number | null;
  submittedAt: string;
  gradedAt: string | null;
  returnedAt: string | null;
}

export interface SubmissionDetailDto extends SubmissionSummaryDto {
  answers: StudentAnswerItem[];
  gradingResult: GradingResultDto | null;
  teacherFeedback: string | null;
}
