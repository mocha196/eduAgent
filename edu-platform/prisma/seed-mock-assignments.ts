/**
 * Mock assignment seed script — creates 2 published assignments with realistic
 * student submissions and graded results for testing the analytics panel.
 *
 * Prerequisites:
 *   Run `npx tsx prisma/seed-mock-students.ts` first so mock students exist.
 *
 * Usage:
 *   cd edu-platform
 *   npx tsx prisma/seed-mock-assignments.ts
 *
 * Safe to re-run: assignments already present (matched by title+courseId) are skipped.
 */

import { PrismaClient, AssignmentStatus, SubmissionStatus } from "@prisma/client";

const prisma = new PrismaClient();

const COURSE_ID = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"; // 计算机网络基础

// ──────────────────────────────────────────────────────────────
// Question definitions
// ──────────────────────────────────────────────────────────────

const ASSIGNMENT_A_QUESTIONS = [
  {
    id: 1,
    type: "single_choice",
    objective: "knowledge",
    entities: ["TCP", "可靠传输"],
    importance_score: 0.9,
    reasoning_steps: 1,
    question: "下列关于 TCP 协议的描述，正确的是？",
    options: [
      "A. TCP 是无连接的传输层协议",
      "B. TCP 提供可靠的、面向连接的字节流服务",
      "C. TCP 不支持流量控制",
      "D. TCP 报文段首部固定为 10 字节",
    ],
    answer: "B",
    explanation: "TCP 是面向连接的可靠传输协议，支持流量控制和拥塞控制，固定首部为 20 字节。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "easy",
  },
  {
    id: 2,
    type: "single_choice",
    objective: "comprehension",
    entities: ["UDP", "传输层"],
    importance_score: 0.85,
    reasoning_steps: 1,
    question: "UDP 协议相比 TCP 协议的主要优势是？",
    options: [
      "A. 提供更可靠的数据传输",
      "B. 支持拥塞控制",
      "C. 传输延迟低，适合实时应用",
      "D. 保证数据按序到达",
    ],
    answer: "C",
    explanation: "UDP 无连接、无流量控制，头部开销小，适合 DNS 查询、视频流等对延迟敏感的场景。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "easy",
  },
  {
    id: 3,
    type: "single_choice",
    objective: "application",
    entities: ["TCP三次握手", "连接建立"],
    importance_score: 0.95,
    reasoning_steps: 2,
    question: "TCP 三次握手过程中，服务器在收到客户端的 SYN 报文后，会发送什么？",
    options: [
      "A. ACK",
      "B. SYN",
      "C. SYN + ACK",
      "D. FIN + ACK",
    ],
    answer: "C",
    explanation: "服务器收到 SYN 后发送 SYN+ACK（第二次握手），客户端再回 ACK（第三次握手）完成连接建立。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "medium",
  },
  {
    id: 4,
    type: "fill_blank",
    objective: "knowledge",
    entities: ["端口号", "传输层"],
    importance_score: 0.8,
    reasoning_steps: 1,
    question: "HTTP 协议默认使用的传输层端口号是 ___，HTTPS 默认端口号是 ___。",
    options: [],
    answer: "80; 443",
    explanation: "HTTP 默认端口 80，HTTPS 默认端口 443，这是 IANA 分配的知名端口。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "easy",
  },
  {
    id: 5,
    type: "fill_blank",
    objective: "comprehension",
    entities: ["TCP拥塞控制", "慢启动"],
    importance_score: 0.9,
    reasoning_steps: 2,
    question: "TCP 拥塞控制的四个阶段分别是：___、___、___、___。",
    options: [],
    answer: "慢启动; 拥塞避免; 快重传; 快恢复",
    explanation:
      "TCP 拥塞控制包括慢启动（指数增长）、拥塞避免（线性增长）、快重传（收到3个重复ACK立即重传）和快恢复。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "hard",
  },
];

const ASSIGNMENT_B_QUESTIONS = [
  {
    id: 1,
    type: "single_choice",
    objective: "knowledge",
    entities: ["IP地址", "子网掩码"],
    importance_score: 0.9,
    reasoning_steps: 1,
    question: "IPv4 地址 192.168.1.100/24 的网络地址是？",
    options: [
      "A. 192.168.1.0",
      "B. 192.168.0.0",
      "C. 192.168.1.255",
      "D. 192.0.0.0",
    ],
    answer: "A",
    explanation: "/24 即子网掩码 255.255.255.0，将主机地址与掩码 AND 运算得到 192.168.1.0。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "easy",
  },
  {
    id: 2,
    type: "single_choice",
    objective: "application",
    entities: ["路由器", "转发表", "最长前缀匹配"],
    importance_score: 0.92,
    reasoning_steps: 2,
    question: "路由器在查找转发表时使用的匹配原则是？",
    options: [
      "A. 最短前缀匹配",
      "B. 最长前缀匹配",
      "C. 精确匹配",
      "D. 随机匹配",
    ],
    answer: "B",
    explanation: "路由器采用最长前缀匹配（Longest Prefix Match）原则，选择匹配位数最多的条目进行转发。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "medium",
  },
  {
    id: 3,
    type: "multi_choice",
    objective: "comprehension",
    entities: ["NAT", "私有地址", "地址转换"],
    importance_score: 0.85,
    reasoning_steps: 2,
    question: "下列属于 RFC 1918 定义的私有 IP 地址范围的有？（多选）",
    options: [
      "A. 10.0.0.0/8",
      "B. 172.16.0.0/12",
      "C. 192.168.0.0/16",
      "D. 224.0.0.0/4",
    ],
    answer: "A,B,C",
    explanation: "RFC 1918 定义了三类私有地址：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16。224.0.0.0/4 是组播地址。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "medium",
  },
  {
    id: 4,
    type: "multi_choice",
    objective: "synthesis",
    entities: ["OSPF", "RIP", "路由协议", "内部网关协议"],
    importance_score: 0.88,
    reasoning_steps: 3,
    question: "以下属于内部网关协议（IGP）的有？（多选）",
    options: [
      "A. OSPF",
      "B. RIP",
      "C. BGP",
      "D. EIGRP",
    ],
    answer: "A,B,D",
    explanation:
      "IGP 用于 AS 内部，包括 RIP（距离矢量）、OSPF（链路状态）、EIGRP（混合型）。BGP 是 EGP，用于 AS 间路由。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "hard",
  },
  {
    id: 5,
    type: "short_answer",
    objective: "comprehension",
    entities: ["ARP", "地址解析协议"],
    importance_score: 0.87,
    reasoning_steps: 2,
    question: "简述 ARP 协议的工作原理，包括其请求和响应的过程。",
    options: [],
    answer: "ARP 广播请求目标 IP 对应的 MAC 地址，目标主机单播回应自身 MAC 地址，发送方缓存该映射。",
    explanation:
      "ARP（地址解析协议）用于在已知 IP 地址的情况下获取对应的 MAC 地址，工作在数据链路层与网络层之间。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "medium",
  },
  {
    id: 6,
    type: "short_answer",
    objective: "application",
    entities: ["DHCP", "动态主机配置"],
    importance_score: 0.83,
    reasoning_steps: 2,
    question: "请描述 DHCP 协议的四步握手过程（DORA）。",
    options: [],
    answer:
      "Discover（客户端广播）→ Offer（服务器回应可用IP）→ Request（客户端请求该IP）→ ACK（服务器确认分配）。",
    explanation:
      "DHCP DORA 过程：客户端先广播 DHCPDISCOVER，服务器响应 DHCPOFFER，客户端回 DHCPREQUEST，服务器最终 DHCPACK 完成地址分配。",
    source_chunk_ids: [],
    score: 5,
    difficulty: "medium",
  },
];

// ──────────────────────────────────────────────────────────────
// Score generation helpers
// ──────────────────────────────────────────────────────────────

/** Scoring "buckets" with their distribution weights for each assignment */
type ScoreBucket = {
  label: string;
  minPct: number;
  maxPct: number;
  weight: number; // relative probability weight
};

const SCORE_BUCKETS: ScoreBucket[] = [
  { label: "0-59",   minPct: 0,  maxPct: 59,  weight: 2 },
  { label: "60-74",  minPct: 60, maxPct: 74,  weight: 3 },
  { label: "75-89",  minPct: 75, maxPct: 89,  weight: 5 },
  { label: "90-100", minPct: 90, maxPct: 100, weight: 3 },
];

/** Deterministically assign a bucket to a student index (seeded distribution) */
function assignBucket(studentIndex: number, totalStudents: number): ScoreBucket {
  const totalWeight = SCORE_BUCKETS.reduce((s, b) => s + b.weight, 0);
  let threshold = 0;
  const position = studentIndex % totalWeight;
  for (const bucket of SCORE_BUCKETS) {
    threshold += bucket.weight;
    if (position < threshold) return bucket;
  }
  return SCORE_BUCKETS[2]; // fallback: 75-89
}

/** Linearly interpolate a score % within a bucket */
function bucketPct(bucket: ScoreBucket, studentIndex: number): number {
  // Use a stable pseudo-random spread inside the bucket
  const spread = ((studentIndex * 17 + 3) % 100) / 100; // 0..1
  return bucket.minPct + spread * (bucket.maxPct - bucket.minPct);
}

type QuestionDef = (typeof ASSIGNMENT_A_QUESTIONS)[number];
type GradeRow = {
  questionId: number;
  score: number;
  maxScore: number;
  isCorrect: boolean | null;
  feedback: string;
  source: "AUTO" | "AI" | "TEACHER";
};

/**
 * Build a gradingResult JSON for a student given a target score percentage.
 * Lower-indexed questions get full score first; harder questions accumulate errors.
 * Questions 4 & 5 (fill_blank, short_answer, multi_choice) have higher error rates.
 */
function buildGradingResult(
  questions: QuestionDef[],
  targetPct: number,
): { totalScore: number; maxScore: number; questionGrades: GradeRow[] } {
  const maxScore = questions.reduce((s, q) => s + q.score, 0);
  const target = Math.round((targetPct / 100) * maxScore);

  // Sort questions so we give full marks to the "easier" ones first (by id asc)
  // then deduct from harder ones when budget runs out
  let remaining = target;
  const grades: GradeRow[] = questions.map((q) => {
    const isObjective =
      q.type === "single_choice" || q.type === "multi_choice";
    const isSimpleObjective = q.type === "single_choice";

    // Decide how much to award this question
    let awarded: number;
    if (remaining >= q.score) {
      awarded = q.score;
    } else {
      // partial or zero — round to nearest integer, non-negative
      awarded = Math.max(0, remaining);
      if (isSimpleObjective) {
        // single_choice: binary (full or zero)
        awarded = awarded >= q.score / 2 ? q.score : 0;
      } else if (q.type === "multi_choice") {
        // multi_choice: round to nearest whole mark
        awarded = Math.round(awarded);
      }
    }
    remaining -= awarded;
    if (remaining < 0) remaining = 0;

    const isCorrect =
      isObjective
        ? awarded === q.score
        : awarded === q.score
        ? true
        : awarded === 0
        ? false
        : null;

    const source: "AUTO" | "AI" =
      isObjective ? "AUTO" : "AI";

    const feedback =
      awarded === q.score
        ? "回答正确，理解准确。"
        : awarded === 0
        ? "回答错误，请重新理解相关知识点。"
        : `部分正确，得 ${awarded}/${q.score} 分，建议进一步复习相关内容。`;

    return {
      questionId: q.id,
      score: awarded,
      maxScore: q.score,
      isCorrect,
      feedback,
      source,
    };
  });

  const totalScore = grades.reduce((s, g) => s + g.score, 0);
  return { totalScore, maxScore, questionGrades: grades };
}

/** Build student's submitted answers JSON (mimics what SubmissionForm sends) */
function buildAnswers(
  questions: QuestionDef[],
  gradingResult: { questionGrades: GradeRow[] },
): { questionId: number; answer: string }[] {
  return questions.map((q) => {
    const grade = gradingResult.questionGrades.find((g) => g.questionId === q.id)!;
    if (grade.score === q.score) {
      // Correct answer
      return { questionId: q.id, answer: q.answer };
    }
    if (grade.score === 0) {
      // Wrong answer
      if (q.type === "single_choice") {
        // Pick a wrong option (cycle through A/B/C/D avoiding correct)
        const wrong = ["A", "B", "C", "D"].find((o) => o !== q.answer) ?? "A";
        return { questionId: q.id, answer: wrong };
      }
      if (q.type === "multi_choice") {
        return { questionId: q.id, answer: "A" }; // incomplete selection
      }
      return { questionId: q.id, answer: "不确定，需要复习。" };
    }
    // Partial — give a half-right answer
    if (q.type === "multi_choice") {
      const parts = q.answer.split(",");
      return { questionId: q.id, answer: parts.slice(0, parts.length - 1).join(",") };
    }
    return { questionId: q.id, answer: "部分理解，答案不完整。" };
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Verify course exists
  const course = await prisma.course.findUnique({
    where: { id: COURSE_ID },
    select: { id: true, name: true },
  });
  if (!course) {
    throw new Error(`Course ${COURSE_ID} not found. Run the app and create the course first.`);
  }
  console.info(`Target course: "${course.name}" (${course.id})`);

  // 2. Find teacher (first teacher enrolled in course or any teacher)
  const teacherEnrollment = await prisma.user.findFirst({
    where: { role: "TEACHER" },
    select: { id: true, username: true },
  });
  if (!teacherEnrollment) {
    throw new Error("No teacher found. Create a teacher account first.");
  }
  console.info(`Using teacher: ${teacherEnrollment.username} (${teacherEnrollment.id})`);

  // 3. Load mock students (enrolled in this course)
  const enrollments = await prisma.courseEnrollment.findMany({
    where: { courseId: COURSE_ID },
    select: { studentId: true, student: { select: { username: true } } },
    orderBy: { enrolledAt: "asc" },
  });
  const students = enrollments
    .filter((e) => e.student.username.startsWith("mock_student_"))
    .map((e) => e.studentId);

  if (students.length === 0) {
    throw new Error(
      "No mock_student_* accounts found enrolled in the course. Run seed-mock-students.ts first.",
    );
  }
  console.info(`Found ${students.length} mock students enrolled.`);

  // ──────────────────────────────────────────────────────────
  // Assignment A
  // ──────────────────────────────────────────────────────────
  await seedAssignment({
    courseId: COURSE_ID,
    teacherId: teacherEnrollment.id,
    title: "第三章：运输层基础",
    deadline: new Date("2026-04-20T23:59:00Z"),
    publishedAt: new Date("2026-04-10T08:00:00Z"),
    questions: ASSIGNMENT_A_QUESTIONS as QuestionDef[],
    students,
    submitCount: Math.min(28, students.length),
    gradedReturnedCount: 26, // RETURNED
    gradedNotReturnedCount: 2, // GRADED
  });

  // ──────────────────────────────────────────────────────────
  // Assignment B
  // ──────────────────────────────────────────────────────────
  await seedAssignment({
    courseId: COURSE_ID,
    teacherId: teacherEnrollment.id,
    title: "第四章：网络层与路由",
    deadline: new Date("2026-05-10T23:59:00Z"),
    publishedAt: new Date("2026-04-28T08:00:00Z"),
    questions: ASSIGNMENT_B_QUESTIONS as QuestionDef[],
    students,
    submitCount: Math.min(22, students.length),
    gradedReturnedCount: 14, // RETURNED
    gradedNotReturnedCount: 4, // GRADED
  });

  console.info("\nDone. Visit /courses/[courseId]/analytics and switch to the assignment tab.");
}

// ──────────────────────────────────────────────────────────────
// Helper: create one assignment + its submissions
// ──────────────────────────────────────────────────────────────

async function seedAssignment(opts: {
  courseId: string;
  teacherId: string;
  title: string;
  deadline: Date;
  publishedAt: Date;
  questions: QuestionDef[];
  students: string[];
  submitCount: number;
  gradedReturnedCount: number;
  gradedNotReturnedCount: number;
}): Promise<void> {
  const {
    courseId,
    teacherId,
    title,
    deadline,
    publishedAt,
    questions,
    students,
    submitCount,
    gradedReturnedCount,
    gradedNotReturnedCount,
  } = opts;

  // Idempotency check
  const existing = await prisma.assignment.findFirst({
    where: { courseId, title },
    select: { id: true },
  });
  if (existing) {
    console.info(`[~] Assignment "${title}" already exists — skipping.`);
    return;
  }

  // Create assignment
  const assignment = await prisma.assignment.create({
    data: {
      courseId,
      createdBy: teacherId,
      title,
      status: AssignmentStatus.PUBLISHED,
      publishedAt,
      deadline,
      teacherRequest: `请生成一份关于"${title}"的综合测试题目。`,
      questions: questions as object[],
      blueprint: {
        title,
        topic: title,
        difficulty: "medium",
        total_count: questions.length,
        questions: questions.map((q) => ({
          id: q.id,
          type: q.type,
          objective: q.objective,
          difficulty: q.difficulty ?? "medium",
          entities: q.entities,
        })),
      },
      qualityReport: {
        overall_score: 0.88,
        passed: true,
        failed_question_ids: [],
        question_reviews: questions.map((q) => ({
          question_id: q.id,
          clarity_score: 0.9,
          difficulty_match: 0.85,
          knowledge_coverage: 0.92,
          passed: true,
          feedback: "题目质量良好。",
        })),
      },
      generationPhase: "completed",
    },
  });
  console.info(`[+] Created assignment: "${title}" (${assignment.id})`);

  // Create submissions
  const submittingStudents = students.slice(0, submitCount);

  let returnedCount = 0;
  let gradedCount = 0;

  for (let i = 0; i < submittingStudents.length; i++) {
    const studentId = submittingStudents[i];
    const bucket = assignBucket(i, submittingStudents.length);
    const pct = bucketPct(bucket, i);
    const grading = buildGradingResult(questions, pct);
    const answers = buildAnswers(questions, grading);

    // Determine submission status
    let status: SubmissionStatus;
    let gradedAt: Date | null = null;
    let returnedAt: Date | null = null;

    if (returnedCount < gradedReturnedCount) {
      status = SubmissionStatus.RETURNED;
      gradedAt = new Date(publishedAt.getTime() + (i + 1) * 3 * 3600 * 1000);
      returnedAt = new Date(gradedAt.getTime() + 3600 * 1000);
      returnedCount++;
    } else if (gradedCount < gradedNotReturnedCount) {
      status = SubmissionStatus.GRADED;
      gradedAt = new Date(publishedAt.getTime() + (i + 1) * 3 * 3600 * 1000);
      gradedCount++;
    } else {
      status = SubmissionStatus.SUBMITTED;
    }

    const hasGrading = status === SubmissionStatus.GRADED || status === SubmissionStatus.RETURNED;
    const maxScore = questions.reduce((s, q) => s + q.score, 0);

    await prisma.assignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
      create: {
        assignmentId: assignment.id,
        studentId,
        answers: answers as object[],
        status,
        gradingResult: hasGrading ? (grading as object) : undefined,
        totalScore: hasGrading ? grading.totalScore : undefined,
        maxScore: hasGrading ? maxScore : undefined,
        teacherFeedback: hasGrading
          ? grading.totalScore >= maxScore * 0.9
            ? "整体表现优秀，继续保持！"
            : grading.totalScore >= maxScore * 0.75
            ? "基础掌握良好，需要加强部分知识点。"
            : "需要重点复习本章内容，建议反复练习。"
          : undefined,
        submittedAt: new Date(publishedAt.getTime() + (i + 1) * 2 * 3600 * 1000),
        gradedAt,
        returnedAt,
      },
      update: {},
    });
    console.info(
      `    [+] Student ${i + 1}/${submittingStudents.length}: ${status}, score=${hasGrading ? grading.totalScore : "?"} / ${maxScore} (${bucket.label})`,
    );
  }

  console.info(
    `    Total: ${submittingStudents.length} submitted, ${returnedCount} RETURNED, ${gradedCount} GRADED`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
