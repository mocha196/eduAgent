"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from "recharts";
import { AlertCircle, BookOpen, CheckCircle2, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ── Types (mirrors analyticsService.ts) ──────────────────────────────────────

type ScoreBucket = { range: string; count: number };

type AssignmentStats = {
  id: string;
  title: string;
  maxScore: number;
  submittedCount: number;
  gradedCount: number;
  returnedCount: number;
  enrolledCount: number;
  submissionRate: number;
  avgScore: number | null;
  scoreDistribution: ScoreBucket[];
};

type QuestionAnalysisItem = {
  assignmentId: string;
  assignmentTitle: string;
  questionId: number;
  questionStem: string;
  questionType: string;
  entities: string[];
  errorRate: number;
  errorCount: number;
  totalAnswered: number;
  avgScore: number;
};

type AssignmentAnalyticsResult = {
  assignments: AssignmentStats[];
  questionAnalysis: QuestionAnalysisItem[];
};

// ── Tooltip for score distribution ───────────────────────────────────────────

function ScoreTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-foreground">{label} 分段</p>
      <p className="text-muted-foreground">{payload[0].value} 人</p>
    </div>
  );
}

// ── Tooltip for error rate ────────────────────────────────────────────────────

function ErrorRateTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: QuestionAnalysisItem; value: number }[];
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload;
  return (
    <div className="max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg space-y-1">
      <p className="font-medium text-foreground leading-snug">{item.questionStem}</p>
      <p className="text-muted-foreground">{item.assignmentTitle}</p>
      <div className="flex gap-3 pt-0.5">
        <span className="text-destructive font-semibold">
          错误率 {Math.round(item.errorRate * 100)}%
        </span>
        <span className="text-muted-foreground">
          {item.errorCount}/{item.totalAnswered} 人答错
        </span>
      </div>
    </div>
  );
}

// ── Score Distribution Chart ──────────────────────────────────────────────────

const BUCKET_COLORS: Record<string, string> = {
  "0-59": "var(--color-err)",
  "60-74": "var(--color-warn)",
  "75-89": "var(--color-ok)",
  "90-100": "var(--color-great)",
};

function ScoreDistributionChart({ distribution }: { distribution: ScoreBucket[] }) {
  if (distribution.every((b) => b.count === 0)) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        暂无批改数据
      </div>
    );
  }
  return (
    <div
      className="h-44 w-full"
      style={
        {
          "--color-err": "oklch(0.60 0.20 25)",
          "--color-warn": "oklch(0.72 0.15 70)",
          "--color-ok": "oklch(0.60 0.14 145)",
          "--color-great": "oklch(0.55 0.15 252)",
        } as React.CSSProperties
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={distribution}
          margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis
            dataKey="range"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<ScoreTooltip />} cursor={{ fill: "transparent" }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {distribution.map((entry) => (
              <Cell
                key={entry.range}
                fill={BUCKET_COLORS[entry.range] ?? "var(--color-ok)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Question Error Rate Chart ─────────────────────────────────────────────────

function QuestionErrorChart({ questions }: { questions: QuestionAnalysisItem[] }) {
  if (questions.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        暂无批改数据
      </div>
    );
  }

  const data = questions.slice(0, 10).map((q, i) => ({
    ...q,
    label: `Q${i + 1}`,
    pct: Math.round(q.errorRate * 100),
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 4, right: 40, left: 28, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border/40" />
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={28}
          />
          <Tooltip
            content={<ErrorRateTooltip />}
            cursor={{ fill: "oklch(0.55 0.15 252 / 0.08)" }}
          />
          <Bar dataKey="pct" radius={[0, 4, 4, 0]} fill="oklch(0.60 0.20 25 / 0.75)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Overview Cards ────────────────────────────────────────────────────────────

function OverviewCards({ stats }: { stats: AssignmentStats }) {
  const submissionPct =
    stats.enrolledCount > 0
      ? Math.round((stats.submittedCount / stats.enrolledCount) * 100)
      : 0;
  const avgPct =
    stats.avgScore !== null && stats.maxScore > 0
      ? Math.round((stats.avgScore / stats.maxScore) * 100)
      : null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users size={12} />
          提交率
        </div>
        <p className="text-2xl font-bold text-foreground">{submissionPct}%</p>
        <p className="text-xs text-muted-foreground">
          {stats.submittedCount}/{stats.enrolledCount} 人
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 size={12} />
          批改率
        </div>
        <p className="text-2xl font-bold text-foreground">
          {stats.submittedCount > 0
            ? Math.round((stats.gradedCount / stats.submittedCount) * 100)
            : 0}%
        </p>
        <p className="text-xs text-muted-foreground">
          {stats.gradedCount}/{stats.submittedCount} 份
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <BookOpen size={12} />
          平均分
        </div>
        <p className="text-2xl font-bold text-foreground">
          {stats.avgScore !== null ? stats.avgScore : "–"}
        </p>
        <p className="text-xs text-muted-foreground">满分 {stats.maxScore} 分</p>
      </div>
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle size={12} />
          得分率
        </div>
        <p className="text-2xl font-bold text-foreground">
          {avgPct !== null ? `${avgPct}%` : "–"}
        </p>
        <p className="text-xs text-muted-foreground">
          {stats.returnedCount} 份已发布
        </p>
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function AssignmentAnalyticsPanel({ courseId }: { courseId: string }) {
  const [data, setData] = useState<AssignmentAnalyticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/courses/${courseId}/analytics/assignments`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(j.error?.message ?? "加载失败");
        }
        return res.json() as Promise<AssignmentAnalyticsResult>;
      })
      .then((d) => {
        setData(d);
        if (d.assignments.length > 0) setSelectedId(d.assignments[0].id);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "加载失败"),
      )
      .finally(() => setLoading(false));
  }, [courseId]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (!data || data.assignments.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
        <AlertCircle size={16} className="text-muted-foreground/40 shrink-0" />
        暂无已发布作业数据
      </div>
    );
  }

  const selected = data.assignments.find((a) => a.id === selectedId) ?? data.assignments[0];
  const filteredQuestions = selectedId
    ? data.questionAnalysis.filter((q) => q.assignmentId === selectedId)
    : data.questionAnalysis;

  return (
    <div className="space-y-6">
      {/* Assignment selector */}
      {data.assignments.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0">查看作业：</span>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className="text-sm border border-border rounded-lg px-2.5 py-1.5 bg-background text-foreground cursor-pointer min-w-0 flex-1 truncate"
          >
            {data.assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Overview cards */}
      <OverviewCards stats={selected} />

      {/* Score distribution */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">分数分布</h3>
        <div className="rounded-xl border border-border bg-card p-4">
          <ScoreDistributionChart distribution={selected.scoreDistribution} />
          <div className="mt-2 flex flex-wrap gap-3 justify-center">
            {[
              { range: "0-59", label: "不及格", color: "bg-[oklch(0.60_0.20_25/0.8)]" },
              { range: "60-74", label: "及格", color: "bg-[oklch(0.72_0.15_70/0.8)]" },
              { range: "75-89", label: "良好", color: "bg-[oklch(0.60_0.14_145/0.8)]" },
              { range: "90-100", label: "优秀", color: "bg-[oklch(0.55_0.15_252/0.8)]" },
            ].map((b) => (
              <div key={b.range} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div className={cn("h-2.5 w-2.5 rounded-sm", b.color)} />
                {b.range} ({b.label})
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Question error rate */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          易错题目 Top 10
          <span className="text-xs font-normal text-muted-foreground">（按错误率排序）</span>
        </h3>
        <div className="rounded-xl border border-border bg-card p-4">
          <QuestionErrorChart questions={filteredQuestions} />
        </div>
        {/* Legend table */}
        {filteredQuestions.length > 0 && (
          <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
            {filteredQuestions.slice(0, 10).map((q, i) => (
              <div key={q.questionId} className="flex items-start gap-3 px-4 py-3">
                <span className="text-xs text-muted-foreground w-6 shrink-0 text-right mt-0.5">
                  Q{i + 1}
                </span>
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="text-sm text-foreground leading-snug line-clamp-2">
                    {q.questionStem}
                    {q.questionStem.length >= 60 ? "…" : ""}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {q.entities.map((e, ei) => (
                      <span
                        key={ei}
                        className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 text-right space-y-0.5">
                  <p
                    className={cn(
                      "text-sm font-semibold",
                      q.errorRate >= 0.6
                        ? "text-destructive"
                        : q.errorRate >= 0.4
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {Math.round(q.errorRate * 100)}%
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {q.errorCount}/{q.totalAnswered}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
