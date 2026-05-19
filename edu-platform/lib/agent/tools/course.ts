/**
 * Course structure tools — give the agent access to course metadata, lesson lists,
 * material lists, and material summaries/transcripts directly from the database.
 */

import { prisma } from "@/lib/db";
import type { Tool, TurnContext } from "../types";

// ---- get_course_info -------------------------------------------------------

export const getCourseInfoTool: Tool = {
  name: "get_course_info",
  description:
    "获取课程基本信息（名称、描述）和课节列表（id、标题、顺序）。" +
    "当 course_id 省略时，若当前会话已绑定课程则返回该课程信息；否则返回用户所有已选课程的简要列表。" +
    "用于了解课程结构、课节安排，以及在回答前确认资料归属的课程/课节。",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      course_id: {
        type: "string",
        description:
          "要查询的课程 UUID。省略时使用当前会话绑定的课程；若无绑定课程则列出所有可访问课程。",
      },
    },
    required: [],
  },
  async execute(args, ctx: TurnContext): Promise<string> {
    const courseId =
      typeof args.course_id === "string" && args.course_id.trim()
        ? args.course_id.trim()
        : ctx.courseId ?? null;

    // No specific course → list all accessible courses
    if (!courseId) {
      if (!ctx.accessibleCourseIds.length) {
        return "当前用户未选修任何课程。";
      }
      const courses = await prisma.course.findMany({
        where: { id: { in: ctx.accessibleCourseIds }, isDeleted: false },
        select: { id: true, name: true, description: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (!courses.length) return "未找到可访问的课程。";
      const lines = courses.map(
        (c) => `- [${c.id}] 《${c.name}》（状态：${c.status}）${c.description ? " — " + c.description.slice(0, 60) : ""}`,
      );
      return `用户已选课程（共 ${courses.length} 门）：\n${lines.join("\n")}`;
    }

    // Fetch course + lessons
    const course = await prisma.course.findFirst({
      where: { id: courseId, isDeleted: false },
      select: { id: true, name: true, description: true, status: true },
    });
    if (!course) return `课程 ${courseId} 不存在或已删除。`;

    const lessons = await prisma.lesson.findMany({
      where: { courseId, isDeleted: false },
      select: { id: true, title: true, description: true, orderIndex: true },
      orderBy: { orderIndex: "asc" },
    });

    const lessonLines = lessons.length
      ? lessons.map(
          (l) =>
            `  ${l.orderIndex + 1}. [${l.id}] ${l.title}${l.description ? " — " + l.description.slice(0, 60) : ""}`,
        )
      : ["  （暂无课节）"];

    return [
      `课程：《${course.name}》（id: ${course.id}，状态：${course.status}）`,
      course.description ? `描述：${course.description.slice(0, 200)}` : "",
      `课节列表（共 ${lessons.length} 节）：`,
      ...lessonLines,
    ]
      .filter(Boolean)
      .join("\n");
  },
};

// ---- list_course_materials -------------------------------------------------

export const listCourseMaterialsTool: Tool = {
  name: "list_course_materials",
  description:
    "列出当前课程的所有资料（文件名、文件类型、索引状态、所属课节、是否有视频摘要）。" +
    "可选按课节 ID 过滤。需要当前会话已绑定课程（course_id 存在于上下文）。",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      lesson_id: {
        type: "string",
        description: "按课节 UUID 过滤，只返回该课节下的资料。省略则返回整门课程的资料。",
      },
      status_filter: {
        type: "string",
        enum: ["READY", "PARSING", "PARSED", "INDEXING", "FAILED", "UPLOADED"],
        description: "可选状态过滤，只返回指定状态的资料。省略则返回所有状态。",
      },
    },
    required: [],
  },
  async execute(args, ctx: TurnContext): Promise<string> {
    if (!ctx.courseId) {
      return "当前会话未绑定课程，无法列出课程资料。请在课程页面内发起对话。";
    }

    const lessonId =
      typeof args.lesson_id === "string" && args.lesson_id.trim()
        ? args.lesson_id.trim()
        : undefined;
    const statusFilter =
      typeof args.status_filter === "string" && args.status_filter.trim()
        ? args.status_filter.trim()
        : undefined;

    const materials = await prisma.material.findMany({
      where: {
        courseId: ctx.courseId,
        isDeleted: false,
        ...(lessonId ? { lessonId } : {}),
        ...(statusFilter ? { status: statusFilter as never } : {}),
      },
      select: {
        id: true,
        originalFilename: true,
        fileType: true,
        status: true,
        lessonId: true,
        indexedChunkCount: true,
        videoSummary: true,
        transcriptText: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!materials.length) {
      return lessonId
        ? `该课节下暂无资料。`
        : `当前课程暂无资料。`;
    }

    const lines = materials.map((m) => {
      const flags: string[] = [];
      if (m.videoSummary) flags.push("有视频摘要");
      if (m.transcriptText) flags.push("有转录文本");
      if (m.indexedChunkCount > 0) flags.push(`已索引 ${m.indexedChunkCount} 块`);
      const flagStr = flags.length ? ` [${flags.join("，")}]` : "";
      return `- [${m.id}] 《${m.originalFilename}》（${m.fileType}，状态：${m.status}${m.lessonId ? "，课节：" + m.lessonId : ""}）${flagStr}`;
    });

    const header = lessonId
      ? `课节 ${lessonId} 下的资料（共 ${materials.length} 份）：`
      : `当前课程资料列表（共 ${materials.length} 份）：`;
    return [header, ...lines].join("\n");
  },
};

// ---- get_material_summary --------------------------------------------------

const TRANSCRIPT_MAX_CHARS = 3000;

export const getMaterialSummaryTool: Tool = {
  name: "get_material_summary",
  description:
    "获取指定资料的详细信息：文件名、类型、视频摘要（videoSummary）和转录文本（transcriptText，截断至前 3000 字）。" +
    "material_id 省略时使用当前预览的资料（如果有）。" +
    "适用于回答\u300c这份资料讲了什么\u300d\u3001\u300c视频内容是什么\u300d等问题。",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      material_id: {
        type: "string",
        description:
          "要查询的资料 UUID。省略时默认使用用户当前正在预览的资料（由上下文提供）。",
      },
    },
    required: [],
  },
  async execute(args, ctx: TurnContext): Promise<string> {
    const materialId =
      typeof args.material_id === "string" && args.material_id.trim()
        ? args.material_id.trim()
        : ctx.materialId ?? null;

    if (!materialId) {
      return (
        "未指定资料 ID，且当前上下文中没有正在预览的资料。" +
        "请先调用 `list_course_materials` 获取资料列表，再用 material_id 参数指定目标资料。"
      );
    }

    const mat = await prisma.material.findFirst({
      where: {
        id: materialId,
        isDeleted: false,
        // Scope to current course if available, for access control
        ...(ctx.courseId ? { courseId: ctx.courseId } : {}),
      },
      select: {
        id: true,
        originalFilename: true,
        fileType: true,
        status: true,
        videoSummary: true,
        transcriptText: true,
        indexedChunkCount: true,
      },
    });

    if (!mat) {
      return `资料 ${materialId} 不存在、已删除或不属于当前课程。`;
    }

    const parts: string[] = [
      `**资料**：《${mat.originalFilename}》（${mat.fileType}，状态：${mat.status}，id: ${mat.id}）`,
    ];

    if (mat.videoSummary) {
      parts.push(`\n**视频/音频摘要**：\n${mat.videoSummary}`);
    } else {
      parts.push(`\n（暂无视频摘要）`);
    }

    if (mat.transcriptText) {
      const truncated = mat.transcriptText.length > TRANSCRIPT_MAX_CHARS;
      const text = truncated
        ? mat.transcriptText.slice(0, TRANSCRIPT_MAX_CHARS) + "\n…（转录文本已截断，仅显示前 3000 字）"
        : mat.transcriptText;
      parts.push(`\n**转录文本**：\n${text}`);
    } else {
      parts.push(`\n（暂无转录文本）`);
    }

    if (mat.indexedChunkCount > 0) {
      parts.push(
        `\n提示：该资料已在知识库中索引 ${mat.indexedChunkCount} 个文本块，可用 \`knowledge_query\` 进行深度语义检索。`,
      );
    }

    return parts.join("\n");
  },
};
