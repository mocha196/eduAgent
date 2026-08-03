import { getLLMClient, getRoleConfig } from "@/lib/agent/llm-registry";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "@/lib/agent/tracing/langfuse-tracer";
import type { QuestionItem, QuestionType } from "@/lib/dto/assignment.dto";
import type { QuestionGradeItem } from "@/lib/dto/submission.dto";

export interface QuestionGradingStrategy {
  supports(type: QuestionType): boolean;
  grade(question: QuestionItem, studentAnswer: string): Promise<QuestionGradeItem>;
}

class ObjectiveGradingStrategy implements QuestionGradingStrategy {
  supports(type: QuestionType): boolean {
    return type === "single_choice" || type === "multi_choice";
  }

  async grade(question: QuestionItem, studentAnswer: string): Promise<QuestionGradeItem> {
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
}

class SubjectiveLlmGradingStrategy implements QuestionGradingStrategy {
  supports(type: QuestionType): boolean {
    return type === "fill_blank" || type === "short_answer";
  }

  async grade(question: QuestionItem, studentAnswer: string): Promise<QuestionGradeItem> {
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
}

export class GradingStrategyRegistry {
  constructor(private readonly strategies: QuestionGradingStrategy[]) {}

  get(type: QuestionType): QuestionGradingStrategy {
    const strategy = this.strategies.find((item) => item.supports(type));
    if (!strategy) {
      throw new Error(`No grading strategy registered for question type: ${type}`);
    }
    return strategy;
  }
}

export const gradingStrategyRegistry = new GradingStrategyRegistry([
  new ObjectiveGradingStrategy(),
  new SubjectiveLlmGradingStrategy(),
]);
