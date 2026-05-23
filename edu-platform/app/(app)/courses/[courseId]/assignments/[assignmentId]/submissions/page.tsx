"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, FileQuestion } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SubmissionListPanel } from "@/components/assignment/SubmissionListPanel";
import { GradingDetailPanel } from "@/components/assignment/GradingDetailPanel";
import type { SubmissionSummaryDto, SubmissionDetailDto } from "@/lib/dto/submission.dto";
import type { QuestionItem } from "@/lib/dto/assignment.dto";
import type { AssignmentDetailDto } from "@/lib/dto/assignment.dto";

interface Stats {
  total: number;
  graded: number;
  returned: number;
  avgScore: number | null;
}

export default function SubmissionsDashboardPage() {
  const { courseId, assignmentId } = useParams<{ courseId: string; assignmentId: string }>();
  const router = useRouter();

  const [userRole, setUserRole] = useState<"STUDENT" | "TEACHER" | "ADMIN" | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);

  const [submissions, setSubmissions] = useState<SubmissionSummaryDto[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, graded: 0, returned: 0, avgScore: null });
  const [assignment, setAssignment] = useState<AssignmentDetailDto | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<SubmissionDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/user", { credentials: "include" })
      .then((r) => r.json() as Promise<{ role?: string }>)
      .then((d) => setUserRole((d.role ?? null) as "STUDENT" | "TEACHER" | "ADMIN" | null))
      .catch(() => setUserRole("STUDENT"))
      .finally(() => setRoleLoading(false));
  }, []);

  useEffect(() => {
    if (roleLoading || !courseId || !assignmentId) return;
    if (userRole === "STUDENT") {
      router.replace(`/courses/${courseId}/assignments/${assignmentId}`);
    }
  }, [assignmentId, courseId, roleLoading, router, userRole]);

  const loadList = useCallback(async () => {
    const [listRes, aRes] = await Promise.all([
      fetch(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`, {
        credentials: "include",
      }),
      fetch(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, { credentials: "include" }),
    ]);

    if (listRes.ok) {
      const d = (await listRes.json()) as {
        submissions: SubmissionSummaryDto[];
        stats: Stats;
      };
      setSubmissions(d.submissions);
      setStats(d.stats);
    }
    if (aRes.ok) {
      const d = (await aRes.json()) as { assignment: AssignmentDetailDto };
      setAssignment(d.assignment);
    }
    setLoading(false);
  }, [courseId, assignmentId]);

  useEffect(() => {
    if (!userRole || userRole === "STUDENT") return;
    void loadList();
  }, [loadList, userRole]);

  async function loadDetail(submissionId: string) {
    setDetailLoading(true);
    setSelectedId(submissionId);
    const res = await fetch(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}`,
      { credentials: "include" },
    );
    if (res.ok) {
      const d = (await res.json()) as { submission: SubmissionDetailDto };
      setSelectedDetail(d.submission);
    }
    setDetailLoading(false);
  }

  async function handleBatchReturn() {
    const res = await fetch(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/batch-return`,
      { method: "POST", credentials: "include" },
    );
    if (res.ok) {
      await loadList();
      if (selectedDetail) await loadDetail(selectedDetail.id);
    }
  }

  async function handleRegrade() {
    if (!selectedDetail) return;
    await fetch(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${selectedDetail.id}/grade`,
      { method: "POST", credentials: "include" },
    );
    // Poll until GRADED
    let attempts = 0;
    const poll = async (): Promise<void> => {
      if (attempts++ > 30) return;
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${selectedDetail.id}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const d = (await res.json()) as { submission: SubmissionDetailDto };
        if (d.submission.status === "GRADED" || d.submission.status === "RETURNED") {
          setSelectedDetail(d.submission);
          setSubmissions((prev) =>
            prev.map((s) => (s.id === d.submission.id ? { ...s, status: d.submission.status } : s)),
          );
          return;
        }
      }
      return poll();
    };
    await poll();
  }

  const questions = (assignment?.questions ?? []) as unknown as QuestionItem[];

  if (roleLoading || !userRole) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
      </div>
    );
  }

  if (userRole === "STUDENT") {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href={`/courses/${courseId}/assignments/${assignmentId}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={20} />
        </Link>
        <FileQuestion size={18} className="text-primary shrink-0" />
        <h1 className="text-lg font-semibold">
          {assignment?.title ?? "作业"} · 提交管理
        </h1>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
          {/* Left: submission list */}
          <div className="lg:col-span-2">
            <SubmissionListPanel
              submissions={submissions}
              stats={stats}
              courseId={courseId}
              assignmentId={assignmentId}
              maxScore={assignment ? getMaxScore(assignment) : null}
              selectedId={selectedId}
              onSelect={(id) => void loadDetail(id)}
              onBatchReturn={handleBatchReturn}
              onRefresh={() => void loadList()}
            />
          </div>

          {/* Right: grading detail */}
          <div className="lg:col-span-3">
            {!selectedId && (
              <div className="rounded-lg border p-10 text-center text-muted-foreground text-sm">
                选择左侧的提交以开始批改
              </div>
            )}
            {selectedId && detailLoading && (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
              </div>
            )}
            {selectedId && !detailLoading && selectedDetail && (
              <GradingDetailPanel
                submission={selectedDetail}
                questions={questions}
                courseId={courseId}
                assignmentId={assignmentId}
                onSaved={(updated) => {
                  setSelectedDetail(updated);
                  setSubmissions((prev) =>
                    prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
                  );
                }}
                onReturned={(updated) => {
                  setSelectedDetail(updated);
                  setSubmissions((prev) =>
                    prev.map((s) =>
                      s.id === updated.id ? { ...s, status: "RETURNED" } : s,
                    ),
                  );
                  void loadList();
                }}
                onRegrade={handleRegrade}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getMaxScore(a: AssignmentDetailDto): number | null {
  if (!Array.isArray(a.questions)) return null;
  return (a.questions as unknown as Array<{ score?: number }>).reduce(
    (s, q) => s + (q.score ?? 0),
    0,
  );
}
