/**
 * Course structure tools — give the agent access to course metadata, lesson lists,
 * material lists, and material summaries/transcripts directly from the database.
 */

import { prisma } from "@/lib/db";
import type { Tool, TurnContext } from "../types";
import { getLLMClient, getVisionModel } from "../llm-registry";
import { buildVisionToolImageUrl } from "./vision";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "tool:course" });

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
    const t0 = Date.now();
    const courseId =
      typeof args.course_id === "string" && args.course_id.trim()
        ? args.course_id.trim()
        : ctx.courseId ?? null;
    log.debug({ courseId, userId: ctx.userId }, "get_course_info start");

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

    const result = [
      `课程：《${course.name}》（id: ${course.id}）`,
      course.description ? `描述：${course.description.slice(0, 200)}` : "",
      `课节列表（共 ${lessons.length} 节）：`,
      ...lessonLines,
    ]
      .filter(Boolean)
      .join("\n");
    log.debug({ courseId, lessonCount: lessons.length, durationMs: Date.now() - t0 }, "get_course_info done");
    return result;
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
        documentSummary: true,
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
      if (m.documentSummary) flags.push("有文档摘要");
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
        documentSummary: true,
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
    }
    if (mat.documentSummary) {
      parts.push(`\n**文档摘要**：\n${mat.documentSummary}`);
    }
    if (!mat.videoSummary && !mat.documentSummary) {
      parts.push(`\n（暂无摘要）`);
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

// ---- view_current_material_page -------------------------------------------

/**
 * Call the vision model on the implicitly-uploaded page screenshot.
 * Returns a text description; OCR-mode retry on empty result; fallback message on failure.
 */
async function describePageImage(
  presignedUrl: string,
  mimeType: string,
  prompt: string,
): Promise<string | null> {
  const imageUrl = await buildVisionToolImageUrl(presignedUrl);
  if (!imageUrl) return null;

  const client = getLLMClient("vision");
  const model = getVisionModel();
  const resp = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 1500,
  });
  return resp.choices[0]?.message?.content?.trim() ?? null;
}

export const viewCurrentMaterialPageTool: Tool = {
  name: "view_current_material_page",
  description:
    "查看用户当前正在预览的资料页面或视频帧截图，获取其视觉内容描述（含图表、文字、公式等）。" +
    "当用户问题涉及\u300c这个图\u300d、\u300c当前页\u300d、\u300c这里\u300d、\u300c图上写的\u300d等指示性表达，" +
    "或当理解当前页面内容有助于回答问题时，应调用此工具。无需任何参数。",
  category: "read",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_args: Record<string, unknown>, ctx: TurnContext): Promise<string> {
    const img = ctx.currentPageImage;
    if (!img?.presigned_url) {
      return (
        "当前没有可用的页面截图。" +
        "如需查看页面内容，请使用预览区右上角的截图按钮，将当前页面作为附件上传。"
      );
    }

    // Primary: ask vision model to describe the page content
    try {
      const description = await describePageImage(
        img.presigned_url,
        img.mime_type,
        "请详细描述这张资料页面的内容，包括文字、图表、公式、表格等所有可见信息。",
      );
      if (description && description.trim().length > 10) {
        return description;
      }
    } catch {
      // Fall through to OCR retry
    }

    // OCR fallback: ask vision model to extract text specifically
    try {
      const ocrResult = await describePageImage(
        img.presigned_url,
        img.mime_type,
        "请提取并输出这张图片中所有可见的文字内容，保持原有格式结构。",
      );
      if (ocrResult && ocrResult.trim().length > 10) {
        return ocrResult;
      }
    } catch {
      // Fall through to user hint
    }

    return (
      "无法解析当前页面的图片内容。" +
      "建议使用预览区右上角的截图按钮，将当前完整页面作为附件上传，以便获得更准确的内容分析。"
    );
  },
};
