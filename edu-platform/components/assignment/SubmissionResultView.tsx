"use client";

import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import type { SubmissionDetailDto } from "@/lib/dto/submission.dto";
import type { QuestionItem } from "@/lib/dto/assignment.dto";

interface Props {
  submission: SubmissionDetailDto;
  /** Full question list from the assignment (with correct answers & explanations). */
  questions: QuestionItem[];
  assignmentTitle: string;
}

const SOURCE_LABEL = { AUTO: "自动判分", AI: "AI批改", TEACHER: "教师批改" } as const;
const SOURCE_COLOR = {
  AUTO: "secondary",
  AI: "outline",
  TEACHER: "default",
} as const;

export function SubmissionResultView({ submission, questions, assignmentTitle }: Props) {
  const gr = submission.gradingResult;
  const questionMap = new Map(questions.map((q) => [q.id, q]));
  const answerMap = new Map(submission.answers.map((a) => [a.questionId, a.answer]));

  const percent =
    gr && gr.maxScore > 0 ? Math.round((gr.totalScore / gr.maxScore) * 100) : null;

  return (
    <div className="space-y-6">
      {/* Score summary */}
      <div className="rounded-lg border bg-card p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{assignmentTitle}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            提交于 {new Date(submission.submittedAt).toLocaleString("zh-CN")}
            {submission.returnedAt &&
              ` · 返回于 ${new Date(submission.returnedAt).toLocaleString("zh-CN")}`}
          </p>
        </div>
        {gr && (
          <div className="text-center">
            <p className="text-4xl font-bold tabular-nums">
              {gr.totalScore}
              <span className="text-lg font-normal text-muted-foreground">
                /{gr.maxScore}
              </span>
            </p>
            {percent !== null && (
              <p className="text-sm text-muted-foreground">{percent}%</p>
            )}
          </div>
        )}
      </div>

      {/* Teacher feedback */}
      {submission.teacherFeedback && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-4">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
            教师整体评语
          </p>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {submission.teacherFeedback}
          </p>
        </div>
      )}

      {/* Per-question results */}
      <div className="space-y-4">
        {gr?.questionGrades.map((qg, idx) => {
          const q = questionMap.get(qg.questionId);
          const studentAnswer = answerMap.get(qg.questionId) ?? "";

          return (
            <div key={qg.questionId} className="rounded-lg border bg-card p-4 space-y-3">
              {/* Question header */}
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium leading-relaxed">
                  <span className="text-muted-foreground mr-2">{idx + 1}.</span>
                  {q?.question ?? `题目 #${qg.questionId}`}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {qg.isCorrect === true && (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  )}
                  {qg.isCorrect === false && (
                    <XCircle className="h-5 w-5 text-destructive" />
                  )}
                  {qg.isCorrect === null && (
                    <MinusCircle className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="text-sm font-semibold tabular-nums">
                    {qg.score}/{qg.maxScore}
                  </span>
                  <Badge variant={SOURCE_COLOR[qg.source]} className="text-xs">
                    {SOURCE_LABEL[qg.source]}
                  </Badge>
                </div>
              </div>

              {/* Student answer */}
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground">你的答案：</p>
                <p className={qg.isCorrect === false ? "text-destructive" : ""}>
                  {studentAnswer || <span className="italic text-muted-foreground">未作答</span>}
                </p>
              </div>

              {/* Correct answer */}
              {qg.isCorrect !== true && (
                <div className="text-sm space-y-1">
                  <p className="text-muted-foreground">正确答案：</p>
                  <p className="text-green-700 dark:text-green-400">
                    {q?.answer ?? qg.correctAnswer ?? "—"}
                  </p>
                </div>
              )}

              {/* Explanation */}
              {q?.explanation && (
                <div className="rounded bg-muted/50 p-3 text-sm space-y-0.5">
                  <p className="font-medium text-xs text-muted-foreground">解析</p>
                  <p>{q?.explanation}</p>
                </div>
              )}

              {/* AI feedback */}
              {qg.feedback && (
                <p className="text-sm text-muted-foreground border-t pt-2">{qg.feedback}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
