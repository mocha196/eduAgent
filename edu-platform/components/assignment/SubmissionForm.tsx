"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Clock, FileText, Send } from "lucide-react";
import type { AssignmentStudentViewDto, StudentQuestionItem } from "@/lib/dto/assignment.dto";
import type { StudentAnswerItem, SubmissionDetailDto } from "@/lib/dto/submission.dto";

interface Props {
  assignment: AssignmentStudentViewDto;
  courseId: string;
  assignmentId: string;
  existingSubmission?: SubmissionDetailDto | null;
  onSubmitted: (submission: SubmissionDetailDto) => void;
}

const TYPE_LABEL: Record<StudentQuestionItem["type"], string> = {
  single_choice: "单选题",
  multi_choice: "多选题",
  fill_blank: "填空题",
  short_answer: "简答题",
};

export function SubmissionForm({ assignment, courseId, assignmentId, existingSubmission, onSubmitted }: Props) {
  const questions = assignment.questions ?? [];
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAnswer(questionId: number, value: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }

  function toggleMultiChoice(questionId: number, option: string) {
    const current = answers[questionId] ?? "";
    const selected = current ? current.split(",") : [];
    const idx = selected.indexOf(option);
    if (idx === -1) {
      selected.push(option);
    } else {
      selected.splice(idx, 1);
    }
    setAnswer(questionId, selected.sort().join(","));
  }

  async function handleSubmit() {
    const payload: StudentAnswerItem[] = questions.map((q) => ({
      questionId: q.id,
      answer: answers[q.id] ?? "",
    }));

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: payload }),
        },
      );
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? "提交失败");
      }
      const data = (await res.json()) as { submission: SubmissionDetailDto };
      onSubmitted(data.submission);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Already submitted banner */}
      {existingSubmission && existingSubmission.status !== "RETURNED" && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-4 text-sm text-blue-700 dark:text-blue-300">
          你已于 {new Date(existingSubmission.submittedAt).toLocaleString("zh-CN")} 提交，当前状态：
          <strong className="ml-1">
            {existingSubmission.status === "GRADING" ? "批改中" : "待批改"}
          </strong>
          。可重新填写答案并再次提交（截止前）。
        </div>
      )}

      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{assignment.title}</h2>
        {assignment.description && (
          <p className="text-sm text-muted-foreground">{assignment.description}</p>
        )}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileText className="h-4 w-4" />
            共 {questions.length} 题 · 满分 {assignment.totalScore} 分
          </span>
          {assignment.deadline && (
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              截止：{new Date(assignment.deadline).toLocaleString("zh-CN")}
            </span>
          )}
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-6">
        {questions.map((q, idx) => (
          <QuestionBlock
            key={q.id}
            index={idx + 1}
            question={q}
            answer={answers[q.id] ?? ""}
            onAnswer={(val) => setAnswer(q.id, val)}
            onToggleMulti={(opt) => toggleMultiChoice(q.id, opt)}
          />
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full sm:w-auto"
      >
        <Send className="mr-2 h-4 w-4" />
        {submitting ? "提交中…" : "提交作业"}
      </Button>
    </div>
  );
}

// ── Per-question block ──────────────────────────────────────────────────────

interface QuestionBlockProps {
  index: number;
  question: StudentQuestionItem;
  answer: string;
  onAnswer: (value: string) => void;
  onToggleMulti: (option: string) => void;
}

function QuestionBlock({
  index,
  question,
  answer,
  onAnswer,
  onToggleMulti,
}: QuestionBlockProps) {
  const selected = answer ? answer.split(",") : [];

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-relaxed">
          <span className="text-muted-foreground mr-2">{index}.</span>
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {TYPE_LABEL[question.type]}
          </Badge>
          <span className="text-xs text-muted-foreground">{question.score}分</span>
        </div>
      </div>

      {question.type === "single_choice" && question.options.length > 0 && (
        <RadioGroup value={answer} onValueChange={onAnswer} className="space-y-1.5">
          {question.options.map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            return (
              <div key={letter} className="flex items-center space-x-2">
                <RadioGroupItem value={letter} id={`q${question.id}-${letter}`} />
                <Label htmlFor={`q${question.id}-${letter}`} className="cursor-pointer text-sm">
                  {letter}. {opt}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      )}

      {question.type === "multi_choice" && question.options.length > 0 && (
        <div className="space-y-1.5">
          {question.options.map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            return (
              <div key={letter} className="flex items-center space-x-2">
                <Checkbox
                  id={`q${question.id}-${letter}`}
                  checked={selected.includes(letter)}
                  onCheckedChange={() => onToggleMulti(letter)}
                />
                <Label
                  htmlFor={`q${question.id}-${letter}`}
                  className="cursor-pointer text-sm"
                >
                  {letter}. {opt}
                </Label>
              </div>
            );
          })}
        </div>
      )}

      {(question.type === "fill_blank" || question.type === "short_answer") && (
        <Textarea
          placeholder={question.type === "fill_blank" ? "请填写答案…" : "请写出你的解答…"}
          value={answer}
          onChange={(e) => onAnswer(e.target.value)}
          rows={question.type === "short_answer" ? 4 : 2}
          className="resize-y"
        />
      )}
    </div>
  );
}
