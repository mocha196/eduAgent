"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { GhostTextarea } from "@/components/assignment/GhostTextarea";
import { CheckCircle2, XCircle, MinusCircle, RotateCcw, Send } from "lucide-react";
import type { SubmissionDetailDto, QuestionGradeItem } from "@/lib/dto/submission.dto";
import type { QuestionItem } from "@/lib/dto/assignment.dto";

interface Props {
  submission: SubmissionDetailDto;
  questions: QuestionItem[];
  courseId: string;
  assignmentId: string;
  onSaved: (updated: SubmissionDetailDto) => void;
  onReturned: (updated: SubmissionDetailDto) => void;
  onRegrade: () => Promise<void>;
}

const SOURCE_LABEL = { AUTO: "自动", AI: "AI", TEACHER: "教师" } as const;

export function GradingDetailPanel({
  submission,
  questions,
  courseId,
  assignmentId,
  onSaved,
  onReturned,
  onRegrade,
}: Props) {
  const gr = submission.gradingResult;
  const questionMap = new Map(questions.map((q) => [q.id, q]));
  const answerMap = new Map(submission.answers.map((a) => [a.questionId, a.answer]));

  // Local editable state for each question grade
  const [scoreOverrides, setScoreOverrides] = useState<Record<number, number>>(
    Object.fromEntries(gr?.questionGrades.map((g) => [g.questionId, g.score]) ?? []),
  );
  const [feedbackOverrides, setFeedbackOverrides] = useState<Record<number, string>>(
    Object.fromEntries(gr?.questionGrades.map((g) => [g.questionId, g.feedback]) ?? []),
  );
  const [teacherFeedback, setTeacherFeedback] = useState(submission.teacherFeedback ?? "");

  const [saving, setSaving] = useState(false);
  const [returning, setReturning] = useState(false);
  const [regrading, setRegrading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalOverride = Object.values(scoreOverrides).reduce((s, v) => s + (v || 0), 0);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const questionGrades = (gr?.questionGrades ?? []).map((g) => ({
        questionId: g.questionId,
        score: scoreOverrides[g.questionId] ?? g.score,
        feedback: feedbackOverrides[g.questionId] ?? g.feedback,
      }));
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${submission.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionGrades, teacherFeedback }),
        },
      );
      if (!res.ok) {
        const d = (await res.json()) as { error?: { message?: string } };
        throw new Error(d.error?.message ?? "保存失败");
      }
      const { submission: updated } = (await res.json()) as { submission: SubmissionDetailDto };
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn() {
    setReturning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${submission.id}/return`,
        { method: "POST" },
      );
      if (!res.ok) {
        const d = (await res.json()) as { error?: { message?: string } };
        throw new Error(d.error?.message ?? "发布失败");
      }
      const { submission: updated } = (await res.json()) as { submission: SubmissionDetailDto };
      onReturned(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发布失败");
    } finally {
      setReturning(false);
    }
  }

  async function handleRegrade() {
    setRegrading(true);
    setError(null);
    try {
      await onRegrade();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新批改失败");
    } finally {
      setRegrading(false);
    }
  }

  if (!gr) {
    return (
      <div className="rounded-lg border p-6 text-center space-y-3">
        <p className="text-muted-foreground">该提交尚未完成批改</p>
        <Button size="sm" onClick={handleRegrade} disabled={regrading}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {regrading ? "批改中…" : "触发AI批改"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Student info + score */}
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{submission.studentName ?? submission.studentId.slice(0, 8)}</p>
          <p className="text-xs text-muted-foreground">
            提交 {new Date(submission.submittedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums">
            {totalOverride}
            <span className="text-base font-normal text-muted-foreground">/{gr.maxScore}</span>
          </p>
          <Badge
            variant={
              submission.status === "RETURNED"
                ? "destructive"
                : submission.status === "GRADED"
                  ? "default"
                  : "secondary"
            }
          >
            {submission.status === "RETURNED"
              ? "已发布"
              : submission.status === "GRADED"
                ? "已批改"
                : "待批改"}
          </Badge>
        </div>
      </div>

      <Separator />

      {/* Per-question grading */}
      <div className="space-y-4">
        {gr.questionGrades.map((qg: QuestionGradeItem, idx: number) => {
          const q = questionMap.get(qg.questionId);
          if (!q) return null;
          const studentAnswer = answerMap.get(qg.questionId) ?? "";
          const isSubjective = q.type === "fill_blank" || q.type === "short_answer";

          return (
            <div key={qg.questionId} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium leading-relaxed">
                  <span className="text-muted-foreground mr-1.5">{idx + 1}.</span>
                  {q.question}
                </p>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {SOURCE_LABEL[qg.source]}
                </Badge>
              </div>

              {/* Student answer vs correct */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">学生答案</p>
                  <p>{studentAnswer || <em className="text-muted-foreground">未作答</em>}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">参考答案</p>
                  <p className="text-green-700 dark:text-green-400">{q.answer}</p>
                </div>
              </div>

              {/* Score override */}
              <div className="flex items-center gap-3">
                {qg.isCorrect === true && <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />}
                {qg.isCorrect === false && <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                {qg.isCorrect === null && <MinusCircle className="h-4 w-4 text-muted-foreground shrink-0" />}
                <Label className="text-sm shrink-0">得分</Label>
                <Input
                  type="number"
                  min={0}
                  max={qg.maxScore}
                  value={scoreOverrides[qg.questionId] ?? qg.score}
                  onChange={(e) =>
                    setScoreOverrides((prev) => ({
                      ...prev,
                      [qg.questionId]: Math.min(qg.maxScore, Math.max(0, Number(e.target.value))),
                    }))
                  }
                  className="w-20 h-8 text-sm"
                />
                <span className="text-sm text-muted-foreground">/ {qg.maxScore}</span>
              </div>

              {/* Feedback — GhostTextarea for subjective, plain text for objective */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">评语</Label>
                {isSubjective ? (
                  <GhostTextarea
                    value={feedbackOverrides[qg.questionId] ?? qg.feedback}
                    onChange={(val) =>
                      setFeedbackOverrides((prev) => ({ ...prev, [qg.questionId]: val }))
                    }
                    rows={2}
                    placeholder="输入评语… (停止输入后 AI 将提供续写建议)"
                    aiContext={{
                      questionText: q.question,
                      studentAnswer,
                      score: scoreOverrides[qg.questionId] ?? qg.score,
                      maxScore: qg.maxScore,
                    }}
                  />
                ) : (
                  <Input
                    value={feedbackOverrides[qg.questionId] ?? qg.feedback}
                    onChange={(e) =>
                      setFeedbackOverrides((prev) => ({
                        ...prev,
                        [qg.questionId]: e.target.value,
                      }))
                    }
                    className="text-sm h-8"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Separator />

      {/* Overall teacher feedback */}
      <div className="space-y-1.5">
        <Label>整体评语</Label>
        <GhostTextarea
          value={teacherFeedback}
          onChange={setTeacherFeedback}
          placeholder="给学生的整体反馈… (停止输入后 AI 将提供续写建议)"
          rows={3}
          aiContext={
            gr.questionGrades[0]
              ? {
                  questionText: "整体作业评价",
                  studentAnswer: `总分 ${totalOverride}/${gr.maxScore}`,
                  score: totalOverride,
                  maxScore: gr.maxScore,
                }
              : undefined
          }
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={handleRegrade} disabled={regrading}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {regrading ? "批改中…" : "重新AI批改"}
        </Button>
        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : "保存修改"}
        </Button>
        {submission.status !== "RETURNED" && (
          <Button size="sm" onClick={handleReturn} disabled={returning}>
            <Send className="mr-1.5 h-4 w-4" />
            {returning ? "发布中…" : "发布给学生"}
          </Button>
        )}
      </div>
    </div>
  );
}
