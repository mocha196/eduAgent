"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, BarChart2, RotateCcw, SendHorizonal } from "lucide-react";
import type { SubmissionSummaryDto } from "@/lib/dto/submission.dto";

interface Stats {
  total: number;
  graded: number;
  returned: number;
  avgScore: number | null;
}

interface Props {
  submissions: SubmissionSummaryDto[];
  stats: Stats;
  courseId: string;
  assignmentId: string;
  maxScore: number | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBatchReturn: () => Promise<void>;
  onRefresh: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "待批改",
  GRADING: "批改中",
  GRADED: "已批改",
  RETURNED: "已发布",
};

const STATUS_VARIANT: Record<string, "secondary" | "outline" | "default" | "destructive"> = {
  SUBMITTED: "secondary",
  GRADING: "outline",
  GRADED: "default",
  RETURNED: "destructive",
};

export function SubmissionListPanel({
  submissions,
  stats,
  maxScore,
  selectedId,
  onSelect,
  onBatchReturn,
  onRefresh,
}: Props) {
  const [batching, setBatching] = useState(false);

  async function handleBatchReturn() {
    setBatching(true);
    try {
      await onBatchReturn();
    } finally {
      setBatching(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="提交数"
          value={String(stats.total)}
        />
        <StatCard
          icon={<BarChart2 className="h-4 w-4" />}
          label="已批改"
          value={`${stats.graded}/${stats.total}`}
        />
        <StatCard
          icon={<SendHorizonal className="h-4 w-4" />}
          label="已发布"
          value={String(stats.returned)}
        />
        <StatCard
          label="平均分"
          value={
            stats.avgScore !== null
              ? `${stats.avgScore.toFixed(1)}${maxScore ? `/${maxScore}` : ""}`
              : "—"
          }
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
        <Button
          size="sm"
          disabled={batching || stats.graded === 0}
          onClick={handleBatchReturn}
        >
          <SendHorizonal className="mr-1.5 h-4 w-4" />
          {batching ? "发布中…" : `一键发布全部已批改 (${stats.graded - stats.returned})`}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>学生</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">得分</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {submissions.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  暂无提交
                </TableCell>
              </TableRow>
            )}
            {submissions.map((s) => (
              <TableRow
                key={s.id}
                className={`cursor-pointer ${selectedId === s.id ? "bg-muted" : "hover:bg-muted/50"}`}
                onClick={() => onSelect(s.id)}
              >
                <TableCell className="font-medium">
                  {s.studentName ?? s.studentId.slice(0, 8)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(s.submittedAt).toLocaleString("zh-CN")}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[s.status]}>
                    {STATUS_LABEL[s.status] ?? s.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.totalScore !== null ? (
                    <span>
                      {s.totalScore}
                      {s.maxScore ? <span className="text-muted-foreground">/{s.maxScore}</span> : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(s.id);
                    }}
                  >
                    批改
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
