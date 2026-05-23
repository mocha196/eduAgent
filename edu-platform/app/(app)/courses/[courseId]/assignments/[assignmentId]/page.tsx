"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Save,
  Send,
  Clock,
  Star,
  FileQuestion,
  Plus,
  Users,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { QuestionCard } from "@/components/assignment/QuestionCard";
import { AddQuestionDialog } from "@/components/assignment/AddQuestionDialog";
import { SubmissionForm } from "@/components/assignment/SubmissionForm";
import { SubmissionResultView } from "@/components/assignment/SubmissionResultView";
import { useNotify } from "@/hooks/useNotify";
import type { AssignmentDetailDto, AssignmentStudentViewDto, QuestionItem, RegenerateQuestionBody } from "@/lib/dto/assignment.dto";
import type { SubmissionDetailDto } from "@/lib/dto/submission.dto";
import { AssignmentStatus } from "@prisma/client";

const STATUS_LABELS: Record<string, string> = {
  GENERATING: "生成中",
  FAILED: "失败",
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  ARCHIVED: "已归档",
};

export default function AssignmentDetailPage() {
  const { courseId, assignmentId } = useParams<{ courseId: string; assignmentId: string }>();
  const { notification, notify } = useNotify();

  const [userRole, setUserRole] = useState<"STUDENT" | "TEACHER" | "ADMIN" | null>(null);

  // ── Student state ──────────────────────────────────────────────────────────
  const [studentAssignment, setStudentAssignment] = useState<AssignmentStudentViewDto | null>(null);
  const [mySubmission, setMySubmission] = useState<SubmissionDetailDto | null>(null);
  const [studentLoaded, setStudentLoaded] = useState(false);

  // ── Teacher state ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const [assignment, setAssignment] = useState<AssignmentDetailDto | null>(null);
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState<QuestionItem[]>([]);

  const sensors = useSensors(useSensor(PointerSensor));

  // Detect role first
  useEffect(() => {
    fetch("/api/v1/user", { credentials: "include" })
      .then((r) => r.json() as Promise<{ role?: string }>)
      .then((d) => setUserRole((d.role ?? "STUDENT") as "STUDENT" | "TEACHER" | "ADMIN"))
      .catch(() => setUserRole("STUDENT"));
  }, []);

  // ── Student load ───────────────────────────────────────────────────────────
  const loadStudent = useCallback(async () => {
    const [aRes, sRes] = await Promise.all([
      fetch(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, { credentials: "include" }),
      fetch(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/mine`, { credentials: "include" }),
    ]);
    if (aRes.ok) {
      const d = (await aRes.json()) as { assignment: AssignmentStudentViewDto };
      setStudentAssignment(d.assignment);
    }
    if (sRes.ok) {
      const d = (await sRes.json()) as { submission: SubmissionDetailDto | null };
      setMySubmission(d.submission);
    }
    setStudentLoaded(true);
  }, [courseId, assignmentId]);

  useEffect(() => {
    if (userRole === "STUDENT") void loadStudent();
  }, [userRole, loadStudent]);

  // ── Teacher load ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const res = await fetch(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}`,
      { credentials: "include" },
    );
    if (res.ok) {
      const d = (await res.json()) as { assignment: AssignmentDetailDto };
      setAssignment(d.assignment);
      setTitle(d.assignment.title);
      setQuestions((d.assignment.questions as QuestionItem[]) ?? []);
    }
    setLoading(false);
  }, [courseId, assignmentId]);

  useEffect(() => {
    if (userRole && userRole !== "STUDENT") void load();
  }, [userRole, load]);

  // Poll while GENERATING (teacher)
  useEffect(() => {
    if (assignment?.status !== AssignmentStatus.GENERATING) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [assignment?.status, load]);

  // ── Student branch ─────────────────────────────────────────────────────────
  if (userRole === "STUDENT") {
    if (!studentLoaded) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      );
    }

    if (!studentAssignment) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-center text-muted-foreground">
          作业不存在或未发布
        </div>
      );
    }

    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`/courses/${courseId}?tab=assignments`} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft size={20} />
          </Link>
          <h1 className="text-lg font-semibold flex-1 truncate">{studentAssignment.title}</h1>
        </div>

        {mySubmission?.status === "RETURNED" ? (
          <SubmissionResultView
            submission={mySubmission}
            questions={(studentAssignment.questions ?? []) as unknown as QuestionItem[]}
            assignmentTitle={studentAssignment.title}
          />
        ) : (
          <SubmissionForm
            assignment={studentAssignment}
            existingSubmission={mySubmission}
            courseId={courseId}
            assignmentId={assignmentId}
            onSubmitted={(sub) => setMySubmission(sub)}
          />
        )}
      </div>
    );
  }



  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setQuestions((prev) => {
        const oldIdx = prev.findIndex((q) => String(q.id) === String(active.id));
        const newIdx = prev.findIndex((q) => String(q.id) === String(over.id));
        return arrayMove(prev, oldIdx, newIdx);
      });
    }
  }

  // ── Question CRUD ──────────────────────────────────────────────────────────
  function handleUpdateQuestion(id: number, updates: Partial<QuestionItem>) {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...updates } : q)));
  }

  function handleDeleteQuestion(id: number) {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  async function handleRegenerateQuestion(qId: number, extraRequirements: string) {
    const q = questions.find((q) => q.id === qId);
    if (!q) return;

    setRegeneratingIds((s) => new Set(s).add(String(qId)));
    try {
      const body: RegenerateQuestionBody = {
        qId,
        qType: q.type,
        objective: q.objective,
        entityNames: q.entities ?? [],
        extraRequirements: extraRequirements || undefined,
        currentQuestion: q.question || undefined,
      };
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/regenerate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { question: QuestionItem };
        setQuestions((prev) => prev.map((q) => (q.id === qId ? { ...d.question, score: q.score } : q)));
        notify("success", "题目已重新生成");
      } else {
        const d = (await res.json()) as { error?: { message: string } };
        notify("error", d.error?.message ?? "重新生成失败");
      }
    } catch {
      notify("error", "网络错误，请重试");
    } finally {
      setRegeneratingIds((s) => {
        const next = new Set(s);
        next.delete(String(qId));
        return next;
      });
    }
  }

  // ── Add custom question ────────────────────────────────────────────────────
  function handleAddQuestion(question: QuestionItem, score: number) {
    setQuestions((prev) => [...prev, { ...question, score }]);
    setAddDialogOpen(false);
    notify("success", "题目已添加，点击「保存草稿」以保存");
  }

  // ── Save (PATCH) ───────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ title, questions }),
        },
      );
      if (res.ok) {
        notify("success", "已保存");
        void load();
      } else {
        const d = (await res.json()) as { error?: { message: string } };
        notify("error", d.error?.message ?? "保存失败");
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Publish ────────────────────────────────────────────────────────────────
  async function handlePublish() {
    if (!confirm("发布后学生可见，确认发布？")) return;
    setPublishing(true);
    try {
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/publish`,
        { method: "POST", credentials: "include" },
      );
      if (res.ok) {
        notify("success", "作业已发布！");
        void load();
      } else {
        const d = (await res.json()) as { error?: { message: string } };
        notify("error", d.error?.message ?? "发布失败");
      }
    } finally {
      setPublishing(false);
    }
  }

  const isDraft = assignment?.status === AssignmentStatus.DRAFT;
  const isGenerating = assignment?.status === AssignmentStatus.GENERATING;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 space-y-6">
      {/* Notification toast */}
      {notification && (
        <div
          className={cn(
            "fixed top-4 right-4 z-50 rounded-lg px-4 py-3 text-sm shadow-lg flex items-center gap-2",
            notification.type === "success"
              ? "bg-green-600 text-white"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {notification.type === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          {notification.msg}
        </div>
      )}

      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link
          href={`/courses/${courseId}/assignments`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={20} />
        </Link>
        <FileQuestion size={18} className="text-primary shrink-0" />
        {loading ? (
          <Skeleton className="h-6 w-48" />
        ) : (
          <h1 className="text-lg font-semibold flex-1 truncate">{assignment?.title}</h1>
        )}
        {!loading && assignment && (
          <span
            className={cn(
              "text-xs rounded-full px-2.5 py-0.5 font-semibold shrink-0",
              assignment.status === "DRAFT" && "bg-yellow-100 text-yellow-700",
              assignment.status === "PUBLISHED" && "bg-green-100 text-green-700",
              assignment.status === "GENERATING" && "bg-blue-100 text-blue-700",
              assignment.status === "FAILED" && "bg-red-100 text-red-700",
            )}
          >
            {isGenerating && <Loader2 size={10} className="inline animate-spin mr-1" />}
            {STATUS_LABELS[assignment.status] ?? assignment.status}
          </span>
        )}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div>
      )}

      {!loading && assignment?.status === "GENERATING" && (
        <GeneratingView phase={assignment.generationPhase ?? null} />
      )}

      {!loading && assignment?.status === "FAILED" && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <AlertCircle size={18} className="text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-destructive">生成失败</p>
            <p className="text-sm text-muted-foreground mt-1">{assignment.errorMessage ?? "未知错误"}</p>
          </div>
          <Link
            href={`/courses/${courseId}/assignments/new?retryFrom=${assignmentId}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-destructive/10 hover:bg-destructive/20 border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive transition-colors"
          >
            修改并重试
          </Link>
        </div>
      )}

      {!loading && (assignment?.status === "DRAFT" || assignment?.status === "PUBLISHED") && (
        <>
          {/* Quality Report */}
          {assignment.qualityReport && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Star size={14} className="text-yellow-500" />
                质量报告
                <span className="ml-auto text-base font-bold text-primary">
                  {(assignment.qualityReport.overall_score * 10).toFixed(1)} / 10
                </span>
              </div>
              {assignment.qualityReport.summary && (
                <p className="text-xs text-muted-foreground">{assignment.qualityReport.summary}</p>
              )}
              {assignment.qualityReport.question_reviews?.some((r) => r.issues.length > 0) && (
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5 mt-1">
                  {assignment.qualityReport.question_reviews
                    ?.flatMap((r) => r.issues)
                    .filter(Boolean)
                    .map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Title edit (draft only) */}
          {isDraft && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">作业标题</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          )}

          {/* Questions */}
          {questions.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-muted-foreground gap-2">
              <FileQuestion size={32} className="opacity-30" />
              <p className="text-sm">暂无题目</p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={questions.map((q) => String(q.id))}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {questions.map((q, i) => (
                    <QuestionCard
                      key={q.id}
                      question={q}
                      index={i}
                      onUpdate={handleUpdateQuestion}
                      onDelete={handleDeleteQuestion}
                      onRegenerate={handleRegenerateQuestion}
                      regenerating={regeneratingIds.has(String(q.id))}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Add custom question (draft only) */}
          {isDraft && (
            <>
              <button
                type="button"
                onClick={() => setAddDialogOpen(true)}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                <Plus size={15} />
                添加自定义题目
              </button>
              <AddQuestionDialog
                open={addDialogOpen}
                onOpenChange={setAddDialogOpen}
                onAdd={handleAddQuestion}
              />
            </>
          )}

          {isDraft && (
            <div className="flex items-center justify-between pt-2 border-t">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock size={12} />
                {assignment.deadline
                  ? `截止 ${new Date(assignment.deadline).toLocaleDateString("zh-CN")}`
                  : "无截止时间"}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="gap-1.5"
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  保存草稿
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handlePublish()}
                  disabled={publishing || questions.length === 0}
                  className="gap-1.5"
                >
                  {publishing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  发布
                </Button>
              </div>
            </div>
          )}

          {assignment.status === "PUBLISHED" && (
            <div className="flex items-center gap-3 pt-2 border-t">
              <CheckCircle2 size={14} className="text-green-600" />
              <span className="text-sm text-muted-foreground flex-1">
                已于 {assignment.publishedAt ? new Date(assignment.publishedAt).toLocaleString("zh-CN") : ""} 发布
              </span>
              <Link href={`/courses/${courseId}/assignments/${assignmentId}/submissions`}>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Users size={14} />
                  查看提交
                </Button>
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Generating animation ─────────────────────────────────────────────────────

const PHASES = [
  { key: "param_extract",    label: "参数识别" },
  { key: "entity_retrieval", label: "实体检索" },
  { key: "blueprint_gen",    label: "蓝图生成" },
  { key: "question_gen",     label: "单题生成" },
  { key: "reviewing",        label: "审阅中" },
  { key: "improving",        label: "改进中" },
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];

function phaseGroup(key: PhaseKey | null): "planner" | "generator" | "reviewer" {
  if (key === "question_gen") return "generator";
  if (key === "reviewing" || key === "improving") return "reviewer";
  return "planner";
}

function GeneratingView({ phase }: { phase: string | null }) {
  const group = phaseGroup(phase as PhaseKey | null);
  const currentIdx = phase ? PHASES.findIndex((p) => p.key === phase) : -1;

  return (
    <div className="flex flex-col items-center justify-center py-14 gap-8 select-none">
      <style>{`
        @keyframes _bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes _dot1 { 0%,80%,100%{opacity:.15} 0%{opacity:1} }
        @keyframes _dot2 { 0%,100%{opacity:.15} 20%{opacity:1} }
        @keyframes _dot3 { 0%,100%{opacity:.15} 40%{opacity:1} }
        @keyframes _pencil { 0%,100%{transform:rotate(-12deg)} 50%{transform:rotate(12deg)} }
        @keyframes _bubble1 { 0%,45%,100%{opacity:0;transform:scale(.8)} 15%,35%{opacity:1;transform:scale(1)} }
        @keyframes _bubble2 { 0%,50%,100%{opacity:0;transform:scale(.8)} 65%,85%{opacity:1;transform:scale(1)} }
        @keyframes _pulse-ring { 0%{transform:scale(1);opacity:.7} 70%,100%{transform:scale(1.6);opacity:0} }
      `}</style>

      {/* Scene */}
      {group === "planner" && <PlannerScene />}
      {group === "generator" && <GeneratorScene />}
      {group === "reviewer" && <ReviewerScene />}

      {/* Phase step list */}
      <div className="flex flex-col gap-2 w-64">
        {PHASES.map((p, i) => {
          const done = currentIdx > i;
          const active = currentIdx === i;
          return (
            <div key={p.key} className="flex items-center gap-2.5">
              <span className="relative flex items-center justify-center w-5 h-5 shrink-0">
                {done && (
                  <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5 text-green-500">
                    <circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15" />
                    <path d="M6 10l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {active && (
                  <>
                    <span className="absolute inset-0 rounded-full bg-primary/30" style={{animation:"_pulse-ring 1.4s ease-out infinite"}} />
                    <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                  </>
                )}
                {!done && !active && (
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/25" />
                )}
              </span>
              <span className={cn(
                "text-sm",
                done && "text-green-600 dark:text-green-400",
                active && "text-foreground font-semibold",
                !done && !active && "text-muted-foreground/50",
              )}>
                {p.label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">生成成功后页面将自动刷新</p>
    </div>
  );
}

function PlannerScene() {
  return (
    <svg width="120" height="110" viewBox="0 0 120 110" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Body */}
      <rect x="35" y="50" width="50" height="42" rx="10" fill="oklch(0.55 0.18 250)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      {/* Head */}
      <rect x="40" y="20" width="40" height="34" rx="10" fill="oklch(0.6 0.18 250)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      {/* Eyes */}
      <circle cx="52" cy="33" r="4" fill="white" />
      <circle cx="68" cy="33" r="4" fill="white" />
      <circle cx="53" cy="34" r="2" fill="oklch(0.3 0.18 250)" />
      <circle cx="69" cy="34" r="2" fill="oklch(0.3 0.18 250)" />
      {/* Antenna */}
      <line x1="60" y1="20" x2="60" y2="10" stroke="oklch(0.55 0.18 250)" strokeWidth="2.5" strokeLinecap="round" style={{animation:"_bob 2s ease-in-out infinite"}} />
      <circle cx="60" cy="8" r="4" fill="oklch(0.7 0.2 220)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      {/* Mouth bar */}
      <rect x="52" y="42" width="16" height="4" rx="2" fill="oklch(0.4 0.15 250)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      {/* Arms */}
      <rect x="20" y="54" width="16" height="8" rx="4" fill="oklch(0.55 0.18 250)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      <rect x="84" y="54" width="16" height="8" rx="4" fill="oklch(0.55 0.18 250)" style={{animation:"_bob 2s ease-in-out infinite"}} />
      {/* Thinking dots */}
      <circle cx="84" cy="18" r="4" fill="oklch(0.65 0.2 250)" style={{animation:"_dot1 1.2s ease-in-out infinite"}} />
      <circle cx="96" cy="11" r="5" fill="oklch(0.65 0.2 250)" style={{animation:"_dot2 1.2s ease-in-out infinite"}} />
      <circle cx="110" cy="5" r="6" fill="oklch(0.65 0.2 250)" style={{animation:"_dot3 1.2s ease-in-out infinite"}} />
    </svg>
  );
}

function GeneratorScene() {
  return (
    <svg width="120" height="110" viewBox="0 0 120 110" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Body */}
      <rect x="35" y="50" width="50" height="42" rx="10" fill="oklch(0.5 0.2 140)" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      {/* Head */}
      <rect x="40" y="20" width="40" height="34" rx="10" fill="oklch(0.55 0.2 140)" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      {/* Eyes (squint — concentrating) */}
      <rect x="48" y="31" width="8" height="4" rx="2" fill="white" />
      <rect x="64" y="31" width="8" height="4" rx="2" fill="white" />
      {/* Mouth smile */}
      <path d="M52 43 Q60 49 68 43" stroke="oklch(0.35 0.15 140)" strokeWidth="2" strokeLinecap="round" fill="none" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      {/* Antenna */}
      <line x1="60" y1="20" x2="60" y2="10" stroke="oklch(0.5 0.2 140)" strokeWidth="2.5" strokeLinecap="round" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      <circle cx="60" cy="8" r="4" fill="oklch(0.7 0.22 110)" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      {/* Arms */}
      <rect x="20" y="54" width="16" height="8" rx="4" fill="oklch(0.5 0.2 140)" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      <rect x="84" y="54" width="16" height="8" rx="4" fill="oklch(0.5 0.2 140)" style={{animation:"_bob 1.8s ease-in-out infinite"}} />
      {/* Pencil held in right hand */}
      <g style={{transformOrigin:"84px 58px", animation:"_pencil 1s ease-in-out infinite"}}>
        <rect x="94" y="42" width="6" height="24" rx="3" fill="oklch(0.85 0.15 80)" />
        <polygon points="94,66 100,66 97,74" fill="oklch(0.75 0.12 50)" />
        <rect x="94" y="42" width="6" height="5" rx="2" fill="oklch(0.65 0.08 20)" />
      </g>
    </svg>
  );
}

function ReviewerScene() {
  return (
    <svg width="160" height="110" viewBox="0 0 160 110" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Reviewer robot (left) */}
      <rect x="10" y="50" width="40" height="40" rx="8" fill="oklch(0.55 0.18 30)" />
      <rect x="14" y="22" width="32" height="30" rx="8" fill="oklch(0.6 0.18 30)" />
      <circle cx="24" cy="35" r="4" fill="white" />
      <circle cx="38" cy="35" r="4" fill="white" />
      <circle cx="25" cy="36" r="2" fill="oklch(0.3 0.15 30)" />
      <circle cx="39" cy="36" r="2" fill="oklch(0.3 0.15 30)" />
      <rect x="22" y="45" width="16" height="3" rx="1.5" fill="oklch(0.42 0.12 30)" />
      {/* Reviewer speech bubble */}
      <g style={{animation:"_bubble1 2.4s ease-in-out infinite"}}>
        <rect x="48" y="4" width="32" height="20" rx="6" fill="oklch(0.6 0.18 30)" />
        <polygon points="52,24 46,30 58,24" fill="oklch(0.6 0.18 30)" />
        <text x="64" y="18" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">?</text>
      </g>

      {/* Fixer robot (right) */}
      <rect x="110" y="50" width="40" height="40" rx="8" fill="oklch(0.5 0.2 280)" />
      <rect x="114" y="22" width="32" height="30" rx="8" fill="oklch(0.55 0.2 280)" />
      <circle cx="124" cy="35" r="4" fill="white" />
      <circle cx="138" cy="35" r="4" fill="white" />
      <circle cx="125" cy="36" r="2" fill="oklch(0.3 0.15 280)" />
      <circle cx="139" cy="36" r="2" fill="oklch(0.3 0.15 280)" />
      <path d="M122 47 Q130 52 138 47" stroke="oklch(0.38 0.12 280)" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* Fixer speech bubble */}
      <g style={{animation:"_bubble2 2.4s ease-in-out infinite"}}>
        <rect x="80" y="4" width="32" height="20" rx="6" fill="oklch(0.55 0.2 280)" />
        <polygon points="102,24 108,30 96,24" fill="oklch(0.55 0.2 280)" />
        <text x="96" y="18" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">✓</text>
      </g>

      {/* Center arrow left-right */}
      <g opacity=".5">
        <line x1="55" y1="70" x2="105" y2="70" stroke="oklch(0.6 0.05 250)" strokeWidth="1.5" strokeDasharray="4 3" />
        <polygon points="100,66 108,70 100,74" fill="oklch(0.6 0.05 250)" />
        <polygon points="60,66 52,70 60,74" fill="oklch(0.6 0.05 250)" />
      </g>
    </svg>
  );
}
