"use client";

import { useState, useTransition } from "react";
import { CheckCircle, XCircle, BookOpen, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types (mirror API DTOs)
// ---------------------------------------------------------------------------

type QuestionType = "SINGLE_CHOICE" | "FILL_BLANK" | "TRUE_FALSE";

export interface ReviewQuestion {
  id: string;
  type: QuestionType;
  stem: string;
  options: string[] | null;
  conceptName: string;
  answeredAt: string | null;
  userAnswer: string | null;
  isCorrect: boolean | null;
}

interface AnswerResult {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
}

export interface MemoryReviewSession {
  sessionId: string;
  questionCount: number;
  answeredCount: number;
  expiresAt: string;
  questions: ReviewQuestion[];
}

interface Props {
  session: MemoryReviewSession;
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEffectiveOptions(q: ReviewQuestion): string[] | null {
  if (q.type === "TRUE_FALSE") return ["正确", "错误"];
  return q.options;
}

// ---------------------------------------------------------------------------
// MemoryReviewCardModal
// ---------------------------------------------------------------------------

export function MemoryReviewCardModal({ session, open, onClose }: Props) {
  // Index into the questions array (only unanswered + already-answered for review)
  const [currentIndex, setCurrentIndex] = useState(() => {
    // Start at first unanswered question
    const firstUnanswered = session.questions.findIndex((q) => q.answeredAt === null);
    return firstUnanswered === -1 ? 0 : firstUnanswered;
  });

  // Per-question reveal state (keyed by question id)
  const [revealed, setRevealed] = useState<Record<string, AnswerResult>>(() => {
    // Pre-populate already-answered questions with placeholder reveal info
    const init: Record<string, AnswerResult> = {};
    for (const q of session.questions) {
      if (q.isCorrect !== null && q.userAnswer !== null) {
        init[q.id] = {
          isCorrect: q.isCorrect,
          correctAnswer: q.userAnswer, // We don't have the correct answer yet for pre-answered
          explanation: "",
        };
      }
    }
    return init;
  });

  const [inputValue, setInputValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const questions = session.questions;
  const currentQuestion = questions[currentIndex];
  const totalCount = questions.length;
  const answeredCount = Object.keys(revealed).length;
  const isLastQuestion = currentIndex === totalCount - 1;
  const isRevealed = currentQuestion ? !!revealed[currentQuestion.id] : false;
  const revealData = currentQuestion ? revealed[currentQuestion.id] : undefined;

  const effectiveOptions = currentQuestion ? getEffectiveOptions(currentQuestion) : null;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleDismiss() {
    startTransition(async () => {
      try {
        await fetch(`/api/v1/me/memory-reviews/${session.sessionId}/dismiss`, {
          method: "POST",
          credentials: "same-origin",
        });
      } catch {
        // best-effort dismiss; still close modal
      } finally {
        onClose();
      }
    });
  }

  function handleConfirm() {
    if (!currentQuestion || !inputValue.trim() || isPending) return;
    setSubmitError(null);

    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/v1/me/memory-reviews/${session.sessionId}/questions/${currentQuestion.id}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ userAnswer: inputValue }),
          },
        );
        if (res.status === 409) {
          // Already answered (e.g. double-click) — just advance
          goNext();
          return;
        }
        if (!res.ok) {
          setSubmitError("提交失败，请重试");
          return;
        }
        const result = (await res.json()) as AnswerResult;
        setRevealed((prev) => ({ ...prev, [currentQuestion.id]: result }));
      } catch {
        setSubmitError("网络错误，请重试");
      }
    });
  }

  function goNext() {
    setInputValue("");
    setSubmitError(null);
    if (currentIndex < totalCount - 1) {
      // Jump to next unanswered if possible, else just next
      const nextUnanswered = questions.findIndex(
        (q, i) => i > currentIndex && !revealed[q.id],
      );
      setCurrentIndex(nextUnanswered !== -1 ? nextUnanswered : currentIndex + 1);
    } else {
      onClose();
    }
  }

  function goPrev() {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setInputValue("");
      setSubmitError(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderAnswerInput() {
    if (!currentQuestion || isRevealed) return null;

    if (currentQuestion.type === "FILL_BLANK") {
      return (
        <Input
          className="mt-4"
          placeholder="输入你的答案..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirm();
          }}
          disabled={isPending}
          autoFocus
        />
      );
    }

    // SINGLE_CHOICE or TRUE_FALSE
    const opts = effectiveOptions ?? [];
    return (
      <RadioGroup
        className="mt-4 space-y-2"
        value={inputValue}
        onValueChange={setInputValue}
        disabled={isPending}
      >
        {opts.map((opt) => (
          <div
            key={opt}
            className={cn(
              "flex items-center space-x-2 rounded-lg border px-4 py-3 cursor-pointer transition-colors",
              inputValue === opt
                ? "border-primary bg-primary/10"
                : "border-border hover:border-primary/50",
            )}
            onClick={() => !isPending && setInputValue(opt)}
          >
            <RadioGroupItem value={opt} id={`opt-${opt}`} />
            <Label htmlFor={`opt-${opt}`} className="cursor-pointer flex-1 text-sm">
              {opt}
            </Label>
          </div>
        ))}
      </RadioGroup>
    );
  }

  function renderRevealedState() {
    if (!revealData) return null;
    return (
      <div
        className={cn(
          "mt-4 rounded-lg p-4 space-y-3",
          revealData.isCorrect
            ? "bg-green-50 border border-green-200 dark:bg-green-950/30 dark:border-green-800"
            : "bg-red-50 border border-red-200 dark:bg-red-950/30 dark:border-red-800",
        )}
      >
        <div className="flex items-center gap-2">
          {revealData.isCorrect ? (
            <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
          ) : (
            <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
          )}
          <span
            className={cn(
              "font-semibold text-sm",
              revealData.isCorrect ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300",
            )}
          >
            {revealData.isCorrect ? "回答正确！" : `正确答案：${revealData.correctAnswer}`}
          </span>
        </div>
        {revealData.explanation && (
          <p className="text-sm text-muted-foreground leading-relaxed">{revealData.explanation}</p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------

  if (!currentQuestion) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleDismiss();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              <DialogTitle className="text-base">每日记忆复习</DialogTitle>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {answeredCount + (isRevealed ? 0 : 0)} / {totalCount} 已完成
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full bg-muted rounded-full h-1.5 mt-2">
            <div
              className="bg-primary h-1.5 rounded-full transition-all"
              style={{ width: `${(answeredCount / totalCount) * 100}%` }}
            />
          </div>
        </DialogHeader>

        {/* Question */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {currentQuestion.conceptName}
            </span>
            <span className="text-xs text-muted-foreground">
              {currentQuestion.type === "SINGLE_CHOICE"
                ? "单选题"
                : currentQuestion.type === "FILL_BLANK"
                  ? "填空题"
                  : "判断题"}
            </span>
          </div>

          <p className="text-sm font-medium leading-relaxed pt-1">
            {currentQuestion.stem}
          </p>

          {/* Answer input (hidden when revealed) */}
          {!isRevealed && renderAnswerInput()}

          {/* Already-answered but current is not yet revealed (navigation) */}
          {currentQuestion.answeredAt && !revealData && (
            <div className="mt-3 text-xs text-muted-foreground">已作答</div>
          )}

          {/* Revealed state */}
          {renderRevealedState()}

          {submitError && (
            <p className="text-xs text-destructive mt-2">{submitError}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2">
          {/* Left: back + dismiss */}
          <div className="flex gap-2">
            {currentIndex > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={goPrev}
                disabled={isPending}
              >
                上一题
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={isPending}
              className="text-muted-foreground"
            >
              稍后再做
            </Button>
          </div>

          {/* Right: confirm / next */}
          {!isRevealed ? (
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!inputValue.trim() || isPending}
            >
              确认
            </Button>
          ) : isLastQuestion ? (
            <Button size="sm" onClick={onClose}>
              完成
            </Button>
          ) : (
            <Button size="sm" onClick={goNext} disabled={isPending}>
              下一题 <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
