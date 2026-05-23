"use client";

import * as React from "react";
import { PlusCircle, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { GhostField } from "@/components/assignment/GhostField";
import type {
  ObjectiveType,
  QuestionItem,
  QuestionType,
  SuggestQuestionBody,
} from "@/lib/dto/assignment.dto";

const OPTION_LABELS = ["A", "B", "C", "D"];

// ── Label mappings ────────────────────────────────────────────────────

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: "single_choice", label: "单选题" },
  { value: "multi_choice", label: "多选题" },
  { value: "fill_blank", label: "填空题" },
  { value: "short_answer", label: "简答题" },
];

const OBJECTIVES: { value: ObjectiveType; label: string }[] = [
  { value: "knowledge", label: "知识记忆" },
  { value: "comprehension", label: "理解分析" },
  { value: "application", label: "应用实践" },
  { value: "synthesis", label: "综合评价" },
  { value: "innovation", label: "创新拓展" },
];

// ── Types ───────────────────────────────────────────────────────────────

interface AddQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the finalized question to the assignment (local state only). */
  onAdd: (question: QuestionItem, score: number) => void;
}

// ── Ghost suggestion helper ────────────────────────────────────────────

async function fetchGhostSuggestion(body: SuggestQuestionBody): Promise<string> {
  const res = await fetch("/api/v1/ai/suggest-question", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) return "";
  const d = (await res.json()) as { suggestion?: string };
  return d.suggestion ?? "";
}

// ── Component ──────────────────────────────────────────────────────────────

export function AddQuestionDialog({ open, onOpenChange, onAdd }: AddQuestionDialogProps) {
  // ── Form fields ────────────────────────────────────────────────────
  const [qType, setQType] = React.useState<QuestionType>("single_choice");
  const [objective, setObjective] = React.useState<ObjectiveType>("knowledge");
  const [entityName, setEntityName] = React.useState("");
  const [questionStem, setQuestionStem] = React.useState("");
  const [explanation, setExplanation] = React.useState("");
  const [score, setScore] = React.useState(5);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // MCQ: 4 option inputs + correct answer letter(s)
  const [mcqOptions, setMcqOptions] = React.useState<string[]>(["", "", "", ""]);
  const [mcqAnswer, setMcqAnswer] = React.useState<string[]>([]);
  // fill_blank / short_answer: reference answer
  const [refAnswer, setRefAnswer] = React.useState("");
  // fill_blank: selection tracking in stem textarea
  const stemRef = React.useRef<HTMLTextAreaElement>(null);
  const [hasSelection, setHasSelection] = React.useState(false);

  const isMCQ = qType === "single_choice" || qType === "multi_choice";

  // Reset when sheet opens
  React.useEffect(() => {
    if (open) {
      setQType("single_choice");
      setObjective("knowledge");
      setEntityName("");
      setQuestionStem("");
      setExplanation("");
      setScore(5);
      setErrors({});
      setMcqOptions(["", "", "", ""]);
      setMcqAnswer([]);
      setRefAnswer("");
      setHasSelection(false);
    }
  }, [open]);

  function handleTypeChange(t: QuestionType) {
    setQType(t);
    setMcqOptions(["", "", "", ""]);
    setMcqAnswer([]);
    setRefAnswer("");
    setHasSelection(false);
  }

  // ── Fill-blank: blank the selected text ──────────────────────────────
  function handleStemSelect() {
    const el = stemRef.current;
    if (!el) return;
    setHasSelection(el.selectionStart !== el.selectionEnd);
  }

  function handleSetBlank() {
    const el = stemRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) return;
    const selected = el.value.slice(start, end);
    setQuestionStem(el.value.slice(0, start) + "____" + el.value.slice(end));
    setRefAnswer((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}；${selected}` : selected;
    });
    setHasSelection(false);
  }

  // ── MCQ answer toggle ────────────────────────────────────────────────
  function toggleMcqAnswer(letter: string) {
    if (qType === "single_choice") {
      setMcqAnswer([letter]);
    } else {
      setMcqAnswer((prev) =>
        prev.includes(letter) ? prev.filter((l) => l !== letter) : [...prev, letter].sort(),
      );
    }
  }

  // ── Validation ───────────────────────────────────────────────────────
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!entityName.trim()) next.entityName = "请填写知识点";
    if (!questionStem.trim()) next.questionStem = "请填写题干";
    if (isMCQ) {
      if (mcqOptions.filter((o) => o.trim()).length < 2) next.mcqOptions = "至少填写两个选项";
      if (mcqAnswer.length === 0) next.mcqAnswer = "请标记正确答案";
    }
    if (score < 1 || score > 100) next.score = "分值应在 1–100 之间";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ── Ghost suggestion callbacks ────────────────────────────────────────
  const getStemSuggestion = React.useCallback(
    async (prefix: string) => {
      if (!entityName.trim()) return "";
      return fetchGhostSuggestion({ field: "stem", qType, entityName: entityName.trim(), prefix });
    },
    [entityName, qType],
  );

  const getExplanationSuggestion = React.useCallback(
    async (prefix: string) => {
      if (!questionStem.trim() || !entityName.trim()) return "";
      const answer = isMCQ ? mcqAnswer.join(";") : refAnswer.trim();
      return fetchGhostSuggestion({
        field: "explanation",
        qType,
        entityName: entityName.trim(),
        stem: questionStem.trim(),
        answer: answer || undefined,
        prefix,
      });
    },
    [entityName, qType, questionStem, isMCQ, mcqAnswer, refAnswer],
  );

  // ── Add ──────────────────────────────────────────────────────────────
  function handleAdd() {
    if (!validate()) return;
    const question: QuestionItem = {
      id: Date.now(),
      type: qType,
      objective,
      entities: [entityName.trim()],
      importance_score: 1,
      reasoning_steps: 1,
      question: questionStem.trim(),
      options: isMCQ ? mcqOptions.map((o) => o.trim()).filter(Boolean) : [],
      answer: isMCQ ? mcqAnswer.join(";") : refAnswer.trim(),
      explanation: explanation.trim(),
      source_chunk_ids: [],
      score,
    };
    onAdd(question, score);
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-5">
          <SheetTitle className="flex items-center gap-2">
            <PlusCircle size={18} />
            添加自定义题目
          </SheetTitle>
          <SheetDescription>
            填写题干时 AI 会自动在后面给出灰色提示，按 Tab 或 → 接受补全。
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 pb-6">
          {/* 题型 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">题型 *</label>
            <div className="flex flex-wrap gap-2">
              {QUESTION_TYPES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleTypeChange(value)}
                  className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                    qType === value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 认知层次 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">认知层次 *</label>
            <div className="flex flex-wrap gap-2">
              {OBJECTIVES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setObjective(value)}
                  className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                    objective === value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 知识点 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">知识点 *</label>
            <Input
              placeholder="例如：TCP 三次握手"
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
            />
            {errors.entityName && <p className="text-xs text-destructive">{errors.entityName}</p>}
          </div>

          {/* 题干 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">题干 *</label>
            {qType === "fill_blank" ? (
              <p className="text-xs text-muted-foreground">
                输入完整句子，<strong>选中要挖空的部分</strong>后点击「设为挖空」。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                填写知识点后输入题干，AI 会给出灰色续写提示，Tab 接受。
              </p>
            )}
            {/* fill_blank uses a plain textarea so we can access selectionStart/End */}
            {qType === "fill_blank" ? (
              <textarea
                ref={stemRef}
                placeholder="例如：TCP连接建立的过程称为____，共需____次握手。"
                rows={5}
                value={questionStem}
                onChange={(e) => setQuestionStem(e.target.value)}
                onSelect={handleStemSelect}
                onMouseUp={handleStemSelect}
                onKeyUp={handleStemSelect}
                className="resize-none flex w-full min-h-[60px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            ) : (
              <GhostField
                multiline
                rows={5}
                placeholder="输入完整题目题干..."
                value={questionStem}
                onChange={setQuestionStem}
                getSuggestion={getStemSuggestion}
                minPrefixLength={5}
              />
            )}
            {qType === "fill_blank" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasSelection}
                onClick={handleSetBlank}
                className="gap-1.5 text-xs"
              >
                <Scissors size={12} />
                设为挖空
              </Button>
            )}
            {errors.questionStem && (
              <p className="text-xs text-destructive">{errors.questionStem}</p>
            )}
          </div>

          {/* 选择题：选项 + 正确答案 */}
          {isMCQ && (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <p className="text-xs font-medium text-muted-foreground">选项与正确答案 *</p>
              <div className="space-y-2">
                {OPTION_LABELS.map((lbl, i) => (
                  <div key={lbl} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleMcqAnswer(lbl)}
                      title={qType === "single_choice" ? "点击选为正确答案" : "点击切换为正确答案之一"}
                      className={`w-6 h-6 shrink-0 rounded-full border text-xs font-bold transition-colors ${
                        mcqAnswer.includes(lbl)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border hover:bg-muted"
                      }`}
                    >
                      {lbl}
                    </button>
                    <Input
                      placeholder={`选项 ${lbl}…`}
                      value={mcqOptions[i]}
                      onChange={(e) => {
                        const next = [...mcqOptions];
                        next[i] = e.target.value;
                        setMcqOptions(next);
                      }}
                      className="text-sm h-8"
                    />
                  </div>
                ))}
              </div>
              {mcqAnswer.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  正确答案：
                  <span className="font-semibold text-foreground">{mcqAnswer.join("、")}</span>
                </p>
              )}
              {errors.mcqOptions && <p className="text-xs text-destructive">{errors.mcqOptions}</p>}
              {errors.mcqAnswer && <p className="text-xs text-destructive">{errors.mcqAnswer}</p>}
            </div>
          )}

          {/* 填空题 / 简答题：参考答案 */}
          {(qType === "fill_blank" || qType === "short_answer") && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {qType === "fill_blank" ? "各空参考答案" : "参考答案"}
                <span className="font-normal text-muted-foreground ml-1">（可选）</span>
              </label>
              {qType === "fill_blank" && (
                <p className="text-xs text-muted-foreground">
                  设为挖空时自动填入，多个空用中文分号「；」分隔。
                </p>
              )}
              <textarea
                placeholder={qType === "fill_blank" ? "例如：三次握手；3" : "参考答案…"}
                rows={2}
                value={refAnswer}
                onChange={(e) => setRefAnswer(e.target.value)}
                className="resize-none flex w-full min-h-[60px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          )}

          {/* 解析（可选，带 ghost text）*/}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              解析
              <span className="font-normal text-muted-foreground ml-1">（可选）</span>
            </label>
            <GhostField
              multiline
              rows={3}
              placeholder="填写题干后 AI 会给出灰色续写提示，Tab 接受；也可直接手写…"
              value={explanation}
              onChange={setExplanation}
              getSuggestion={getExplanationSuggestion}
              minPrefixLength={3}
            />
          </div>

          {/* 分值 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">分值</label>
            <Input
              type="number"
              min={1}
              max={100}
              value={score}
              onChange={(e) => setScore(Number(e.target.value))}
              className="w-24"
            />
            {errors.score && <p className="text-xs text-destructive">{errors.score}</p>}
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background pt-4 pb-2 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleAdd}>确认添加</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
