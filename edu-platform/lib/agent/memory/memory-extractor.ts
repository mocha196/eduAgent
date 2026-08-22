/**
 * MemoryExtractor — uses LLM to extract Facts from a conversation transcript.
 * Mirrors Python memory/extractor.py.
 */

import OpenAI from "openai";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "../tracing/langfuse-tracer";
import type { Message } from "../types";
import type { Fact, FactCategory } from "./types";

const EXTRACT_SYSTEM = `你是一个学习记忆提取器。给定一段师生对话记录，提取出关于学习者的事实（Facts）。
每个 Fact 必须是以下 JSON 格式的对象，放入一个 JSON 数组：
[
  {
    "category": "concept_mastery|concept_confusion|preference|difficulty|question|achievement",
    "content": "简洁描述这个事实（中文，50字以内）",
    "confidence": 0.0到1.0的浮点数
  }
]
只提取有实质意义的学习相关事实。若无值得记录的事实，返回空数组 []。
直接返回 JSON，不要其他文字。`;

const EXTRACT_SUBMISSION_SYSTEM = `你是一个学习记忆提取器。下面是学生完成的作业批改结果，请提取关于该学生学习情况的简洁事实（Facts）。
每个 Fact 必须是以下 JSON 格式的对象，放入一个 JSON 数组：
[
  {
    "category": "concept_mastery|concept_confusion|difficulty|achievement",
    "content": "简洁描述这个事实（中文，50字以内），需提及具体知识点名称",
    "confidence": 0.0到1.0的浮点数
  }
]
提取规则：
- 答对满分的题目 → category: "concept_mastery"，confidence 取 0.75~0.95
- 答错或明显低分（得分率<60%）的题目 → category: "concept_confusion"，confidence 取 0.7~0.9
- 总分率≥80%（全卷表现优秀）→ 额外加一条 category: "achievement"
- content 必须提及该题的知识点实体名称（如有），不超过50字
- 对于无明确对错的低分主观题，可用 category: "difficulty"
- 若无值得记录的事实，返回空数组 []
直接返回 JSON，不要其他文字。`;

export type SubmissionQuestionContext = {
  stem: string;
  type: string;
  entities: string[];
  studentAnswer: string;
  score: number;
  maxScore: number;
  isCorrect: boolean | null;
  feedback: string;
  correctAnswer: string;
};

export type SubmissionMemoryContext = {
  assignmentTitle: string;
  totalScore: number;
  maxScore: number;
  questions: SubmissionQuestionContext[];
};

type RawFact = {
  category: FactCategory;
  content: string;
  confidence: number;
};

export class MemoryExtractor {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async extractFactsFromSession(
    userId: string,
    sessionId: string,
    messages: Message[],
  ): Promise<Omit<Fact, "id">[]> {
    const transcript = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const role = m.role === "user" ? "学生" : "助手";
        return `${role}: ${m.content}`;
      })
      .join("\n");

    if (!transcript.trim()) return [];

    let raw: string;
    try {
      const trace = createStandaloneTrace({
        name: "memory.extract",
        userId,
        sessionId,
        metadata: { model: this.model, messageCount: messages.length },
      });
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: `对话记录：\n${transcript.slice(0, 8000)}` },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });
      raw = resp.choices[0]?.message?.content ?? "[]";
      recordGeneration(trace, {
        name: "extract_facts_llm",
        model: this.model,
        input: transcript.slice(0, 500),
        output: raw,
        usage: {
          promptTokens: resp.usage?.prompt_tokens,
          completionTokens: resp.usage?.completion_tokens,
          totalTokens: resp.usage?.total_tokens,
        },
      });
      void flushLangfuse();
    } catch (err) {
      console.error("[MemoryExtractor] LLM call failed:", err);
      return [];
    }

    let parsed: RawFact[];
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned) as RawFact[];
      if (!Array.isArray(parsed)) return [];
    } catch (err) {
      console.error("[MemoryExtractor] JSON parse failed:", err);
      return [];
    }

    const now = new Date();
    return parsed
      .filter((f) => f.category && f.content && typeof f.confidence === "number")
      .map((f) => ({
        userId,
        sessionId,
        timestamp: now,
        category: f.category,
        content: f.content.slice(0, 500),
        confidence: Math.max(0, Math.min(1, f.confidence)),
        sourceJson: { session_id: sessionId },
        metadata: {},
      }));
  }

  async extractFactsFromSubmission(
    userId: string,
    submissionId: string,
    ctx: SubmissionMemoryContext,
  ): Promise<Omit<Fact, "id">[]> {
    const sessionId = `assignment:${submissionId}`;

    const typeLabels: Record<string, string> = {
      single_choice: "单选题",
      multi_choice: "多选题",
      fill_blank: "填空题",
      short_answer: "简答题",
    };

    const lines = ctx.questions.map((q) => {
      const entitiesStr = q.entities.length > 0 ? q.entities.join("、") : "（无标注）";
      const typeLabel = typeLabels[q.type] ?? q.type;
      const stemShort = q.stem.length > 40 ? q.stem.slice(0, 40) + "…" : q.stem;
      const resultLabel =
        q.isCorrect === true ? "✓正确" : q.isCorrect === false ? "✗错误" : "低分";
      return (
        `- [知识点: ${entitiesStr}] ${typeLabel} "${stemShort}"` +
        ` → 得${q.score}/${q.maxScore}分 ${resultLabel}\n` +
        `  学生答案：${q.studentAnswer || "（未作答）"}\n` +
        `  批改反馈：${q.feedback}`
      );
    });

    const userContent =
      `作业：${ctx.assignmentTitle}\n总分：${ctx.totalScore}/${ctx.maxScore}\n\n各题批改结果：\n` +
      lines.join("\n");

    let raw: string;
    try {
      const trace = createStandaloneTrace({
        name: "memory.extract_submission",
        userId,
        sessionId,
        metadata: { model: this.model, submissionId, questionCount: ctx.questions.length },
      });
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: EXTRACT_SUBMISSION_SYSTEM },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });
      raw = resp.choices[0]?.message?.content ?? "[]";
      recordGeneration(trace, {
        name: "extract_submission_facts_llm",
        model: this.model,
        input: userContent.slice(0, 500),
        output: raw,
        usage: {
          promptTokens: resp.usage?.prompt_tokens,
          completionTokens: resp.usage?.completion_tokens,
          totalTokens: resp.usage?.total_tokens,
        },
      });
      void flushLangfuse();
    } catch (err) {
      console.error("[MemoryExtractor] submission LLM call failed:", err);
      return [];
    }

    let parsed: RawFact[];
    try {
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned) as RawFact[];
      if (!Array.isArray(parsed)) return [];
    } catch (err) {
      console.error("[MemoryExtractor] submission JSON parse failed:", err);
      return [];
    }

    const now = new Date();
    return parsed
      .filter(
        (f) =>
          f.category && f.content && typeof f.confidence === "number" && f.confidence >= 0.6,
      )
      .map((f) => ({
        userId,
        sessionId,
        timestamp: now,
        category: f.category,
        content: f.content.slice(0, 500),
        confidence: Math.max(0, Math.min(1, f.confidence)),
        sourceJson: { session_id: sessionId, submission_id: submissionId },
        metadata: {},
      }));
  }
}
