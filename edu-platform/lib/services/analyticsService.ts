import { prisma } from "@/lib/db";

export type CourseAnalyticsResult = {
  total_questions: number;
  avg_response_time_ms: number;
  top_questions: {
    question: string;
    count: number;
    avg_quality: number | null;
  }[];
  active_students: {
    student_id: string;
    name: string | null;
    question_count: number;
    last_active: string;
  }[];
  top_materials: {
    material_id: string;
    title: string | null;
    hit_count: number;
  }[];
  weak_concepts: { concept: string; count: number; resources: string[] }[];
};

function parseDate(s: string | null, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Course-level aggregates for teachers (B3). No per-student raw Q/A in this payload.
 */
export async function getCourseAnalytics(
  courseId: string,
  startDate: string | null,
  endDate: string | null,
): Promise<CourseAnalyticsResult> {
  const end = parseDate(endDate, new Date());
  const start = parseDate(
    startDate,
    new Date(end.getTime() - 7 * 24 * 3600 * 1000),
  );

  const totals = await prisma.$queryRaw<
    { c: bigint; avg_ms: number | null }[]
  >`
    SELECT COUNT(*)::bigint AS c, AVG(execution_time_ms)::float AS avg_ms
    FROM qa_logs
    WHERE course_id = ${courseId}::uuid
      AND deleted_at IS NULL
      AND created_at >= ${start}
      AND created_at <= ${end}
  `;
  const total_questions = Number(totals[0]?.c ?? 0);
  const avg_response_time_ms = Math.round(totals[0]?.avg_ms ?? 0);

  const top_questions = await prisma.$queryRaw<
    { question: string; count: number; avg_quality: number | null }[]
  >`
    SELECT question,
           COUNT(*)::int AS count,
           AVG(response_quality)::float AS avg_quality
    FROM qa_logs
    WHERE course_id = ${courseId}::uuid
      AND deleted_at IS NULL
      AND created_at >= ${start}
      AND created_at <= ${end}
    GROUP BY question
    ORDER BY count DESC
    LIMIT 15
  `;

  const active_students = await prisma.$queryRaw<
    {
      student_id: string;
      question_count: number;
      last_active: Date;
      name: string | null;
    }[]
  >`
    SELECT l.student_id::text AS student_id,
           COUNT(*)::int AS question_count,
           MAX(l.created_at) AS last_active,
           u.real_name AS name
    FROM qa_logs l
    JOIN users u ON u.id = l.student_id
    WHERE l.course_id = ${courseId}::uuid
      AND l.deleted_at IS NULL
      AND l.created_at >= ${start}
      AND l.created_at <= ${end}
    GROUP BY l.student_id, u.real_name
    ORDER BY question_count DESC
    LIMIT 20
  `;

  const matHits = await prisma.$queryRaw<
    { material_id: string; hit_count: bigint }[]
  >`
    SELECT m AS material_id, COUNT(*)::bigint AS hit_count
    FROM qa_logs, unnest(hit_materials) AS m
    WHERE course_id = ${courseId}::uuid
      AND deleted_at IS NULL
      AND created_at >= ${start}
      AND created_at <= ${end}
    GROUP BY m
    ORDER BY hit_count DESC
    LIMIT 15
  `;

  const titles: Record<string, string | null> = {};
  for (const row of matHits) {
    const mat = await prisma.material.findFirst({
      where: { id: row.material_id, isDeleted: false },
      select: { originalFilename: true },
    });
    titles[row.material_id] = mat?.originalFilename ?? null;
  }

  return {
    total_questions,
    avg_response_time_ms,
    top_questions: top_questions.map((r) => ({
      question: r.question,
      count: r.count,
      avg_quality: r.avg_quality,
    })),
    active_students: active_students.map((r) => ({
      student_id: r.student_id,
      name: r.name,
      question_count: r.question_count,
      last_active: r.last_active.toISOString(),
    })),
    top_materials: matHits.map((r) => ({
      material_id: r.material_id,
      title: titles[r.material_id] ?? null,
      hit_count: Number(r.hit_count),
    })),
    weak_concepts: [],
  };
}

export type KnowledgeAnalyticsRange = "7d" | "30d" | "all";

export type KnowledgeAnalyticsResult = {
  high_frequency_questions: {
    question: string;
    frequency: number;
    related_knowledge_points: string[];
  }[];
  error_prone_knowledge_points: {
    knowledge_point: string;
    error_rate: number;
    error_count: number;
  }[];
  knowledge_heatmap: {
    knowledge_point: string;
    heat_score: number;
  }[];
};

/**
 * Lightweight knowledge analytics for the course analytics panel (teachers only).
 * - high_frequency_questions: top 5 by count with resolved material names
 * - error_prone_knowledge_points: placeholder ([]); ready for future extension
 * - knowledge_heatmap: top 10 materials by hit count
 */
export async function getKnowledgeAnalytics(
  courseId: string,
  range: KnowledgeAnalyticsRange,
): Promise<KnowledgeAnalyticsResult> {
  const now = new Date();
  let start: Date;
  if (range === "7d") {
    start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  } else if (range === "30d") {
    start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  } else {
    // "all" — epoch start
    start = new Date(0);
  }

  // --- High-frequency questions top 5 ---
  const topQuestions = await prisma.$queryRaw<
    { question: string; count: number; hit_materials: string[] }[]
  >`
    SELECT
      question,
      COUNT(*)::int AS count,
      array_agg(DISTINCT m) FILTER (WHERE m IS NOT NULL) AS hit_materials
    FROM qa_logs, LATERAL unnest(hit_materials) AS m
    WHERE course_id = ${courseId}::uuid
      AND deleted_at IS NULL
      AND created_at >= ${start}
      AND created_at <= ${now}
    GROUP BY question
    ORDER BY count DESC
    LIMIT 5
  `;

  // Resolve material IDs → filenames (batch)
  const allMaterialIds = [...new Set(topQuestions.flatMap((r) => r.hit_materials ?? []))];
  const materialMap: Record<string, string> = {};
  if (allMaterialIds.length > 0) {
    const mats = await prisma.material.findMany({
      where: { id: { in: allMaterialIds }, isDeleted: false },
      select: { id: true, originalFilename: true },
    });
    for (const m of mats) materialMap[m.id] = m.originalFilename;
  }

  const high_frequency_questions = topQuestions.map((r) => ({
    question: r.question,
    frequency: r.count,
    related_knowledge_points: (r.hit_materials ?? [])
      .map((id) => materialMap[id] ?? id)
      .filter(Boolean),
  }));

  // --- Knowledge heatmap: top 10 materials by hit count ---
  const matHits = await prisma.$queryRaw<
    { material_id: string; hit_count: bigint }[]
  >`
    SELECT m AS material_id, COUNT(*)::bigint AS hit_count
    FROM qa_logs, unnest(hit_materials) AS m
    WHERE course_id = ${courseId}::uuid
      AND deleted_at IS NULL
      AND created_at >= ${start}
      AND created_at <= ${now}
    GROUP BY m
    ORDER BY hit_count DESC
    LIMIT 10
  `;

  // Resolve any IDs not already in materialMap
  const newIds = matHits
    .map((r) => r.material_id)
    .filter((id) => !(id in materialMap));
  if (newIds.length > 0) {
    const extra = await prisma.material.findMany({
      where: { id: { in: newIds }, isDeleted: false },
      select: { id: true, originalFilename: true },
    });
    for (const m of extra) materialMap[m.id] = m.originalFilename;
  }

  const knowledge_heatmap = matHits.map((r) => ({
    knowledge_point: materialMap[r.material_id] ?? r.material_id,
    heat_score: Number(r.hit_count),
  }));

  // --- Error-prone knowledge points from assignment submissions ---
  const error_prone_knowledge_points = await computeErrorProneKnowledgePoints(courseId);

  return {
    high_frequency_questions,
    error_prone_knowledge_points,
    knowledge_heatmap,
  };
}

export type LearningProgressResult = {
  student_id: string;
  total_questions: number;
  topics_covered: string[];
  weak_areas: string[];
  recent_activity: string | null;
  engagement_score: number;
};

/** Heuristic progress from ``qa_logs`` (B3). */
export async function getStudentLearningProgress(
  studentId: string,
): Promise<LearningProgressResult> {
  const logs = await prisma.qaLog.findMany({
    where: { studentId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { question: true, createdAt: true },
  });
  const total = logs.length;
  const topics = new Set<string>();
  for (const l of logs) {
    const q = l.question.trim().slice(0, 80);
    if (q.length >= 4) topics.add(q);
  }
  const recent = logs[0]?.createdAt ?? null;
  const engagement_score =
    total === 0 ? 0 : Math.min(1, total / 50 + (topics.size / 20) * 0.5);

  return {
    student_id: studentId,
    total_questions: total,
    topics_covered: [...topics].slice(0, 30),
    weak_areas: [],
    recent_activity: recent ? recent.toISOString() : null,
    engagement_score: Math.round(engagement_score * 100) / 100,
  };
}

// ── Assignment Analytics ──────────────────────────────────────────────────────

export type ScoreBucket = { range: string; count: number };

export type AssignmentStats = {
  id: string;
  title: string;
  maxScore: number;
  submittedCount: number;
  gradedCount: number;
  returnedCount: number;
  enrolledCount: number;
  submissionRate: number;
  avgScore: number | null;
  scoreDistribution: ScoreBucket[];
};

export type QuestionAnalysisItem = {
  assignmentId: string;
  assignmentTitle: string;
  questionId: number;
  questionStem: string;
  questionType: string;
  entities: string[];
  errorRate: number;
  errorCount: number;
  totalAnswered: number;
  avgScore: number;
};

export type AssignmentAnalyticsResult = {
  assignments: AssignmentStats[];
  questionAnalysis: QuestionAnalysisItem[];
};

type GradeRow = {
  questionId: number;
  score: number;
  maxScore: number;
  isCorrect: boolean | null;
};

type GradingResultJson = {
  totalScore: number;
  maxScore: number;
  questionGrades: GradeRow[];
};

type QuestionJson = {
  id: number;
  type: string;
  entities?: string[];
  question: string;
  score: number;
};

function parseGradingResult(raw: unknown): GradingResultJson | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.totalScore !== "number" || !Array.isArray(r.questionGrades)) return null;
  return raw as GradingResultJson;
}

/** Internal: compute error-prone knowledge points from all course submissions. */
async function computeErrorProneKnowledgePoints(
  courseId: string,
): Promise<{ knowledge_point: string; error_rate: number; error_count: number }[]> {
  // Fetch all graded submissions for this course
  const submissions = await prisma.assignmentSubmission.findMany({
    where: {
      assignment: { courseId },
      status: { in: ["GRADED", "RETURNED"] },
    },
    select: { gradingResult: true, assignment: { select: { questions: true } } },
  });

  // Map: entity name → { errorCount, totalAnswered }
  const entityStats = new Map<string, { errorCount: number; totalAnswered: number }>();

  for (const sub of submissions) {
    const grading = parseGradingResult(sub.gradingResult);
    if (!grading) continue;
    const questions: QuestionJson[] = Array.isArray(sub.assignment.questions)
      ? (sub.assignment.questions as QuestionJson[])
      : [];
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    for (const grade of grading.questionGrades) {
      const q = questionMap.get(grade.questionId);
      if (!q) continue;
      const entities = q.entities ?? [];
      const isWrong = grade.isCorrect === false || (grade.score < grade.maxScore && grade.maxScore > 0);
      for (const entity of entities) {
        if (!entity) continue;
        const cur = entityStats.get(entity) ?? { errorCount: 0, totalAnswered: 0 };
        cur.totalAnswered += 1;
        if (isWrong) cur.errorCount += 1;
        entityStats.set(entity, cur);
      }
    }
  }

  return Array.from(entityStats.entries())
    .filter(([, v]) => v.totalAnswered >= 1)
    .map(([entity, v]) => ({
      knowledge_point: entity,
      error_rate: Math.round((v.errorCount / v.totalAnswered) * 100) / 100,
      error_count: v.errorCount,
    }))
    .sort((a, b) => b.error_rate - a.error_rate)
    .slice(0, 10);
}

/**
 * Assignment-level analytics for a course (teachers only).
 * Returns per-assignment stats and per-question error rates.
 * @param assignmentId - optional filter to a single assignment
 */
export async function getAssignmentAnalytics(
  courseId: string,
  assignmentId?: string,
): Promise<AssignmentAnalyticsResult> {
  // Enrolled student count
  const enrolledCount = await prisma.courseEnrollment.count({ where: { courseId } });

  // Fetch published assignments (optionally filtered)
  const assignments = await prisma.assignment.findMany({
    where: {
      courseId,
      status: { in: ["PUBLISHED", "ARCHIVED"] },
      ...(assignmentId ? { id: assignmentId } : {}),
    },
    select: { id: true, title: true, questions: true },
    orderBy: { publishedAt: "desc" },
  });

  const assignmentStats: AssignmentStats[] = [];
  const allQuestionAnalysis: QuestionAnalysisItem[] = [];

  for (const assignment of assignments) {
    const questions: QuestionJson[] = Array.isArray(assignment.questions)
      ? (assignment.questions as QuestionJson[])
      : [];
    const maxScore = questions.reduce((acc, q) => acc + (q.score ?? 0), 0);

    // Fetch all submissions for this assignment
    const submissions = await prisma.assignmentSubmission.findMany({
      where: { assignmentId: assignment.id },
      select: { status: true, gradingResult: true },
    });

    const submittedCount = submissions.length;
    const gradedCount = submissions.filter(
      (s) => s.status === "GRADED" || s.status === "RETURNED",
    ).length;
    const returnedCount = submissions.filter((s) => s.status === "RETURNED").length;

    // Score distribution and avg score (only graded submissions)
    const gradedSubs = submissions
      .map((s) => parseGradingResult(s.gradingResult))
      .filter((g): g is GradingResultJson => g !== null);

    const buckets: Record<string, number> = {
      "0-59": 0,
      "60-74": 0,
      "75-89": 0,
      "90-100": 0,
    };
    let scoreSum = 0;
    for (const g of gradedSubs) {
      const effMax = g.maxScore || maxScore || 1;
      const pct = (g.totalScore / effMax) * 100;
      if (pct < 60) buckets["0-59"] += 1;
      else if (pct < 75) buckets["60-74"] += 1;
      else if (pct < 90) buckets["75-89"] += 1;
      else buckets["90-100"] += 1;
      scoreSum += g.totalScore;
    }

    const avgScore =
      gradedSubs.length > 0
        ? Math.round((scoreSum / gradedSubs.length) * 10) / 10
        : null;

    assignmentStats.push({
      id: assignment.id,
      title: assignment.title,
      maxScore,
      submittedCount,
      gradedCount,
      returnedCount,
      enrolledCount,
      submissionRate:
        enrolledCount > 0
          ? Math.round((submittedCount / enrolledCount) * 100) / 100
          : 0,
      avgScore,
      scoreDistribution: Object.entries(buckets).map(([range, count]) => ({
        range,
        count,
      })),
    });

    // Per-question error rate analysis
    const qStats = new Map<
      number,
      { errorCount: number; totalAnswered: number; scoreSum: number }
    >();
    for (const q of questions) {
      qStats.set(q.id, { errorCount: 0, totalAnswered: 0, scoreSum: 0 });
    }

    for (const g of gradedSubs) {
      for (const grade of g.questionGrades) {
        const stat = qStats.get(grade.questionId);
        if (!stat) continue;
        stat.totalAnswered += 1;
        stat.scoreSum += grade.score;
        if (grade.isCorrect === false || (grade.score < grade.maxScore && grade.maxScore > 0)) {
          stat.errorCount += 1;
        }
      }
    }

    for (const q of questions) {
      const stat = qStats.get(q.id);
      if (!stat || stat.totalAnswered === 0) continue;
      allQuestionAnalysis.push({
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        questionId: q.id,
        questionStem: q.question.replace(/<[^>]+>/g, "").slice(0, 60),
        questionType: q.type,
        entities: q.entities ?? [],
        errorRate: Math.round((stat.errorCount / stat.totalAnswered) * 100) / 100,
        errorCount: stat.errorCount,
        totalAnswered: stat.totalAnswered,
        avgScore:
          stat.totalAnswered > 0
            ? Math.round((stat.scoreSum / stat.totalAnswered) * 10) / 10
            : 0,
      });
    }
  }

  // Sort question analysis by error rate descending
  allQuestionAnalysis.sort((a, b) => b.errorRate - a.errorRate);

  return {
    assignments: assignmentStats,
    questionAnalysis: allQuestionAnalysis.slice(0, 20),
  };
}
