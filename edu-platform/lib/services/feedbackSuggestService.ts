import { getLLMClient, getRoleConfig } from "@/lib/agent/llm-registry";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "@/lib/agent/tracing/langfuse-tracer";
import type { SuggestFeedbackBody } from "@/lib/dto/submission.dto";

/**
 * Generate an AI continuation suggestion for teacher feedback text.
 * Uses LLM_AUXILIARY_MODEL (grading role) to continue the teacher's partial comment.
 */
export async function suggestFeedback(
  body: SuggestFeedbackBody,
): Promise<{ suggestion: string }> {
  const config = getRoleConfig("grading");
  const client = getLLMClient("grading");

  const system = `你是一位经验丰富的教师，正在为学生的作业答案撰写简洁、专业的中文评语。
请续写教师已输入的评语前缀，使其成为完整的评语。
要求：
- 续写内容自然衔接前缀
- 语言简洁，不超过50字
- 关注学生答案的得失分原因
- 不要重复前缀内容，只输出续写部分`;

  const user = `题目：${body.questionText}
学生答案：${body.studentAnswer}
得分：${body.score}/${body.maxScore}

教师已输入的评语前缀：${body.prefix || "（空）"}

请直接输出续写内容（不要包含任何标签或解释）：`;

  try {
    const trace = createStandaloneTrace({
      name: "teaching.suggest_feedback",
      metadata: { model: config.model },
    });
    const resp = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 128,
    });
    const suggestion = resp.choices[0]?.message?.content?.trim() ?? "";
    recordGeneration(trace, {
      name: "suggest_feedback_llm",
      model: config.model,
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      output: suggestion,
      usage: {
        promptTokens: resp.usage?.prompt_tokens,
        completionTokens: resp.usage?.completion_tokens,
        totalTokens: resp.usage?.total_tokens,
      },
    });
    void flushLangfuse();
    return { suggestion };
  } catch {
    return { suggestion: "" };
  }
}
