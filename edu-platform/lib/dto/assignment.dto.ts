import type { AssignmentStatus } from "@prisma/client";

export type { AssignmentStatus };

export type QuestionType = "single_choice" | "multi_choice" | "fill_blank" | "short_answer";
export type ObjectiveType = "knowledge" | "comprehension" | "application" | "synthesis" | "innovation";

export interface QuestionItem {
  id: number;
  type: QuestionType;
  objective: ObjectiveType;
  /** All knowledge entities this question draws on (primary first). application/synthesis/innovation may have multiple. */
  entities: string[];
  importance_score: number;
  /** Number of reasoning steps the LLM self-reported for this question. Used for difficulty_match evaluation. */
  reasoning_steps: number;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  source_chunk_ids: string[];
  /** Teacher-assigned point value (default 5) */
  score: number;
  /** Difficulty level inherited from the blueprint slot */
  difficulty?: "easy" | "medium" | "hard";
}

export interface BlueprintQuestion {
  id: number;
  type: QuestionType;
  objective: ObjectiveType;
  difficulty: "easy" | "medium" | "hard";
  entity_names: string[];
  focus: string;
}

export interface Blueprint {
  title: string;
  difficulty_weights: { easy: number; medium: number; hard: number };
  questions: BlueprintQuestion[];
}

export interface QuestionReview {
  id: number;
  clarity: number;
  difficulty_match: number;
  issues: string[];
  suggestion: string | null;
}

export interface QualityReport {
  overall_score: number;
  passed: boolean;
  threshold: number;
  question_reviews: QuestionReview[];
  failed_ids: number[];
  difficulty_distribution_score: number;
  summary: string;
}

export interface QuestionAdoptionMetrics {
  generatedCount: number;
  retainedCount: number;
  unchangedCount: number;
  modifiedCount: number;
  deletedCount: number;
  teacherAddedCount: number;
  /** AI-origin question IDs retained at publication / generatedCount. */
  adoptionRate: number;
  /** AI-origin questions published without pedagogical-content edits / generatedCount. */
  directAdoptionRate: number;
  calculatedAt: string;
}

// ── Request bodies ──────────────────────────────────────────────────────────

export interface StructuredGenerationParams {
  lessonIds: string[];
  lessonNames: string[];
  knowledgePoints: string[];
  difficultyWeights: { easy: number; medium: number; hard: number };
  count: number;
  typeWeights: Record<string, number>;
  objectiveWeights: Record<string, number>;
}

export interface GenerateAssignmentBody {
  title: string;
  teacherRequest: string;
  deadline?: string; // ISO-8601
  structuredParams?: StructuredGenerationParams;
}

export interface PatchAssignmentBody {
  title?: string;
  description?: string;
  deadline?: string; // ISO-8601 or null to clear
  questions?: QuestionItem[];
}

export interface RegenerateQuestionBody {
  entityNames: string[];
  qType: QuestionType;
  objective: ObjectiveType;
  qId: number;
  extraRequirements?: string;
  /** Current question text, used by LLM as reference when regenerating */
  currentQuestion?: string;
}

export interface CompleteQuestionBody {
  entityNames: string[];
  qType: QuestionType;
  objective: ObjectiveType;
  /** Teacher-written stem (HTML or plain text). AI will not modify this. */
  questionStem: string;
  /** Optional answer hint from the teacher. */
  answerHint?: string;
  /** For MCQ: teacher-supplied option texts [A, B, C, D]. Empty strings mean AI fills that option. */
  prefilledOptions?: string[];
  /** For MCQ: correct answer letter(s) selected by teacher, e.g. "A" or "A;C". For fill_blank/short_answer: expected answer text. */
  prefilledAnswer?: string;
  /** Point value for the new question (default 5). */
  score?: number;
}

export interface SuggestQuestionBody {
  /** Which field is requesting a ghost-text suggestion. */
  field: "stem" | "explanation";
  qType: QuestionType;
  entityName: string;
  /** Text the teacher has typed so far (the prefix to continue). */
  prefix: string;
  /** Current stem (for explanation field). */
  stem?: string;
  /** Current answer (for explanation field). */
  answer?: string;
}

// ── Response DTOs ───────────────────────────────────────────────────────────

export interface AssignmentSummaryDto {
  id: string;
  title: string;
  status: AssignmentStatus;
  questionCount: number;
  qualityScore: number | null;
  deadline: string | null;
  createdAt: string;
  errorMessage: string | null;
  generationPhase?: string | null;
  /** Student-only: submission status for the current student. null = not submitted yet. */
  mySubmissionStatus?: string | null;
}

export interface AssignmentDetailDto extends AssignmentSummaryDto {
  description: string | null;
  blueprint: Blueprint | null;
  questions: QuestionItem[] | null;
  qualityReport: QualityReport | null;
  adoptionMetrics: QuestionAdoptionMetrics | null;
  publishedAt: string | null;
  /** Original NLP request stored for retry. */
  teacherRequest: string | null;
  /** Original structured params stored for retry. */
  structuredParams: StructuredGenerationParams | null;
}

/** Question as seen by a student — answer/explanation redacted until RETURNED. */
export type StudentQuestionItem = Omit<QuestionItem, "answer" | "explanation"> & {
  answer: null;
  explanation: null;
};

/** Assignment view for enrolled students (no answers until submission is returned). */
export interface AssignmentStudentViewDto {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  publishedAt: string | null;
  questions: StudentQuestionItem[] | null;
  totalScore: number;
}
