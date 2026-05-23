import { getLLMClient, getRoleConfig } from "@/lib/agent/llm-registry";
import { createStandaloneTrace, flushLangfuse, recordGeneration } from "@/lib/agent/tracing/langfuse-tracer";
import type { SuggestQuestionBody } from "@/lib/dto/assignment.dto";

const TYPE_LABELS: Record<string, string> = {
  single_choice: "单选题",
  multi_choice: "多选题",
  fill_blank: "填空题",
  short_answer: "简答题",
};

function buildPrompt(body: SuggestQuestionBody): { prompt: string; maxTokens: number; stop: string[] } {
  const typeName = TYPE_LABELS[body.qType] ?? body.qType;

  switch (body.field) {
    case "stem":
      return {
        prompt:
          `你是一位计算机网络课程出题教师，正在编写一道${typeName}。请直接续写题干，不要添加任何解释或标签：\n` +
          `知识点：${body.entityName}\n` +
          `题干：${body.prefix}`,
        maxTokens: 80,
        stop: ["\n", "答案", "解析", "A.", "A、", "选项"],
      };

    case "explanation":
      return {
        prompt:
          `你是一位计算机网络课程出题教师，正在为一道${typeName}编写解析。请直接续写解析内容，不要添加任何解释或标签：\n` +
          `知识点：${body.entityName}\n` +
          `题干：${body.stem ?? ""}\n` +
          `答案：${body.answer ?? ""}\n` +
          `解析：${body.prefix}`,
        maxTokens: 100,
        stop: ["\n\n", "["],
      };
  }
}

/**
 * Generate a ghost-text continuation suggestion for a custom question field.
 * Uses the FIM (text completions) endpoint so the model directly continues
 * the teacher's partial text without wrapping or reformatting.
 */
export async function suggestQuestion(
  body: SuggestQuestionBody,
): Promise<{ suggestion: string }> {
  const config = getRoleConfig("completion");
  const client = getLLMClient("completion");

  const { prompt, maxTokens, stop } = buildPrompt(body);

  const trace = createStandaloneTrace({
    name: "teaching.suggest_question",
    metadata: { model: config.model, field: body.field },
  });

  const resp = await client.completions.create({
    model: config.model,
    prompt,
    max_tokens: maxTokens,
    temperature: 0.3,
    stop,
  });

  const suggestion = resp.choices[0]?.text?.trim() ?? "";

  recordGeneration(trace, {
    name: "suggest_question_fim",
    model: config.model,
    input: [{ role: "user", content: prompt }],
    output: suggestion,
    usage: {
      promptTokens: resp.usage?.prompt_tokens,
      completionTokens: resp.usage?.completion_tokens,
      totalTokens: resp.usage?.total_tokens,
    },
  });
  void flushLangfuse();

  return { suggestion };
}
