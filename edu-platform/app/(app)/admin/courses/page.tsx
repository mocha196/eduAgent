"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  BookOpen,
  Search,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  LayoutList,
  FileStack,
  GraduationCap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FilterSelect } from "@/components/FilterSelect";

type CourseStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

type CourseItem = {
  id: string;
  name: string;
  description: string | null;
  status: CourseStatus;
  createdAt: string;
  updatedAt: string;
  teacher: {
    id: string;
    username: string;
    realName: string | null;
  };
  _count: {
    enrollments: number;
    lessons: number;
    materials: number;
  };
};

type Pagination = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type SortField = "enrollments" | "lessons" | "materials" | "createdAt";
type SortDir = "asc" | "desc";

function useNotify() {
  const [n, setN] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const notify = (type: "success" | "error", msg: string) => {
    setN({ type, msg });
    setTimeout(() => setN(null), 4000);
  };
  return { notification: n, notify };
}

const statusConfig: Record<CourseStatus, { label: string; color: string }> = {
  DRAFT: {
    label: "草稿",
    color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  },
  PUBLISHED: {
    label: "已发布",
    color: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400",
  },
  ARCHIVED: {
    label: "已归档",
    color: "bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-500",
  },
};

const STATUS_FILTERS = [
  { value: "", label: "全部状态" },
  { value: "PUBLISHED", label: "已发布" },
  { value: "DRAFT", label: "草稿" },
  { value: "ARCHIVED", label: "已归档" },
];

/** 表头列：图标 + 文字，可点击排序 */
function HeaderCell({
  icon: Icon,
  label,
  sortable = false,
  active = false,
  direction = "desc",
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  sortable?: boolean;
  active?: boolean;
  direction?: SortDir;
  onClick?: () => void;
}) {
  const SortIcon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={sortable ? onClick : undefined}
            role={sortable ? "button" : undefined}
            className={cn(
              "inline-flex items-center gap-1 select-none",
              sortable
                ? "cursor-pointer hover:text-foreground transition-colors"
                : "cursor-default",
              active ? "text-foreground" : "",
            )}
          >
            <Icon size={12} />
            <span className="hidden sm:inline">{label}</span>
            {sortable && (
              <SortIcon
                size={11}
                className={cn(
                  "transition-colors",
                  active ? "text-primary" : "text-muted-foreground/40",
                )}
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function AdminCoursesPage() {
  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const { notification, notify } = useNotify();

  const [statusFilter, setStatusFilter] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [courseSearchInput, setCourseSearchInput] = useState("");
  const [teacherSearch, setTeacherSearch] = useState("");
  const [teacherSearchInput, setTeacherSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // colFrs[0..6]: 课程名称, 授课教师, 状态, 选课学生, 课节数, 资料数, 创建时间
  // proportional fr units — all columns scale together when container resizes
  const [colFrs, setColFrs] = useState([32, 16, 9, 9, 8, 8, 11]);
  const tableRef = useRef<HTMLDivElement>(null);

  const gridTemplate = colFrs.map((f) => `${f}fr`).join(" ");

  function startResize(e: React.PointerEvent<HTMLDivElement>, colIdx: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const containerW = tableRef.current?.offsetWidth ?? 800;
    const totalFr = colFrs.reduce((a, b) => a + b, 0);
    const startLeft = colFrs[colIdx];
    const startRight = colFrs[colIdx + 1];
    const onMove = (ev: PointerEvent) => {
      const rawDelta = ((ev.clientX - startX) / containerW) * totalFr;
      // clamp so neither column goes below 4fr
      const delta = Math.max(4 - startLeft, Math.min(startRight - 4, rawDelta));
      setColFrs((prev) => {
        const next = [...prev];
        next[colIdx] = startLeft + delta;
        next[colIdx + 1] = startRight - delta;
        return next;
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (statusFilter) sp.set("status", statusFilter);
      if (courseSearch) sp.set("search", courseSearch);
      if (teacherSearch) sp.set("teacher", teacherSearch);
      sp.set("page", String(page));
      sp.set("sortBy", sortBy);
      sp.set("sortDir", sortDir);

      const res = await fetch(`/api/v1/admin/courses?${sp.toString()}`, {
        credentials: "include",
      });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { notify("error", "加载失败"); return; }
      const data = (await res.json()) as { courses: CourseItem[]; pagination: Pagination };
      setCourses(data.courses);
      setPagination(data.pagination);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, courseSearch, teacherSearch, page, sortBy, sortDir]);

  useEffect(() => { void load(); }, [load]);

  function applySearch() {
    setCourseSearch(courseSearchInput);
    setTeacherSearch(teacherSearchInput);
    setPage(1);
  }

  function toggleSort(field: SortField) {
    setPage(1);
    if (sortBy === field) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir("desc");
  }

  function getVisiblePages(currentPage: number, totalPages: number) {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 3) return [1, 2, 3, 4, 5];
    if (currentPage >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [currentPage - 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2];
  }

  if (forbidden) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        仅管理员可访问此页面
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {notification && (
        <div
          className={cn(
            "fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg",
            notification.type === "success"
              ? "bg-[oklch(0.92_0.08_145)] text-[oklch(0.35_0.10_145)]"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {notification.type === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {notification.msg}
        </div>
      )}

      <div className="max-w-6xl mx-auto w-full px-6 py-8 space-y-6">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <BookOpen size={20} className="text-primary" />
            课程管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            查看平台上所有教师的课程及其运行状况。
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-end">
          {/* Course name search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              type="text"
              placeholder="搜索课程名…"
              value={courseSearchInput}
              onChange={(e) => setCourseSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              className="w-full rounded-lg border bg-background pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Teacher search */}
          <div className="relative min-w-[160px]">
            <GraduationCap
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              type="text"
              placeholder="按教师搜索…"
              value={teacherSearchInput}
              onChange={(e) => setTeacherSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              className="w-full rounded-lg border bg-background pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <Button size="sm" onClick={applySearch} variant="secondary">
            搜索
          </Button>

          {/* Status filter */}
          <FilterSelect
            options={STATUS_FILTERS}
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
          />
        </div>

        {/* Stats bar */}
        {pagination && !loading && (
          <p className="text-xs text-muted-foreground">
            共 <span className="font-medium text-foreground">{pagination.total}</span> 门课程
            {pagination.total > 0 &&
              `，当前第 ${(pagination.page - 1) * pagination.pageSize + 1}–${Math.min(
                pagination.page * pagination.pageSize,
                pagination.total,
              )} 条`}
          </p>
        )}

        {/* Table */}
        <div ref={tableRef} className="rounded-xl border bg-card overflow-hidden">
          {/* Table header */}
          <div
            className="grid gap-0 border-b bg-muted/30 px-4 py-2.5 text-xs font-medium text-muted-foreground select-none"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {/* 课程名称 — colIdx 0, handle resizes 0⇔1 boundary */}
            <div className="relative group/col pr-3">
              课程名称
              <div
                className="absolute right-0 top-1/2 -translate-y-1/2 h-4/5 w-1 flex items-center justify-center cursor-col-resize opacity-0 group-hover/col:opacity-100 hover:opacity-100 transition-opacity z-10"
                onPointerDown={(e) => startResize(e, 0)}
              >
                <div className="w-px h-full bg-border rounded-full" />
              </div>
            </div>
            {[
              { label: "授课教师", colIdx: 1 },
              { label: "状态", colIdx: 2 },
            ].map(({ label, colIdx }) => (
              <div key={label} className="relative group/col pr-2">
                {label}
                <div
                  className="absolute right-0 top-1/2 -translate-y-1/2 h-4/5 w-1 flex items-center justify-center cursor-col-resize opacity-0 group-hover/col:opacity-100 hover:opacity-100 transition-opacity z-10"
                  onPointerDown={(e) => startResize(e, colIdx)}
                >
                  <div className="w-px h-full bg-border rounded-full" />
                </div>
              </div>
            ))}
            {[
              { icon: Users, label: "选课学生", field: "enrollments" as SortField, colIdx: 3 },
              { icon: LayoutList, label: "课节数", field: "lessons" as SortField, colIdx: 4 },
              { icon: FileStack, label: "资料数", field: "materials" as SortField, colIdx: 5 },
            ].map(({ icon, label, field, colIdx }) => (
              <div key={field} className="relative group/col text-center">
                <HeaderCell
                  icon={icon}
                  label={label}
                  sortable
                  active={sortBy === field}
                  direction={sortDir}
                  onClick={() => toggleSort(field)}
                />
                <div
                  className="absolute right-0 top-1/2 -translate-y-1/2 h-4/5 w-1 flex items-center justify-center cursor-col-resize opacity-0 group-hover/col:opacity-100 hover:opacity-100 transition-opacity z-10"
                  onPointerDown={(e) => startResize(e, colIdx)}
                >
                  <div className="w-px h-full bg-border rounded-full" />
                </div>
              </div>
            ))}
            {/* 创建时间 — last column, no handle */}
            <div className="text-right">创建时间</div>
          </div>

          {loading ? (
            <div className="divide-y">
              {[1, 2, 3, 4, 5].map((k) => (
                <div
                  key={k}
                  className="grid gap-0 px-4 py-3.5 items-center"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-14" />
                  <Skeleton className="h-4 w-6 mx-auto" />
                  <Skeleton className="h-4 w-6 mx-auto" />
                  <Skeleton className="h-4 w-6 mx-auto" />
                  <Skeleton className="h-4 w-20 ml-auto" />
                </div>
              ))}
            </div>
          ) : courses.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              暂无符合条件的课程
            </div>
          ) : (
            <div className="divide-y">
              {courses.map((course) => {
                const sc = statusConfig[course.status];
                const createdDate = new Date(course.createdAt).toLocaleDateString("zh-CN", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                });
                return (
                  <div
                    key={course.id}
                    className="grid gap-0 px-4 py-3 items-center text-sm transition-colors hover:bg-muted/20"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    {/* Course name */}
                    <div className="min-w-0 pr-3">
                      <div className="font-medium text-foreground truncate">{course.name}</div>
                      {course.description && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {course.description}
                        </div>
                      )}
                    </div>

                    {/* Teacher */}
                    <div className="min-w-0 pr-2">
                      <div className="text-sm truncate">{course.teacher.username}</div>
                      {course.teacher.realName && (
                        <div className="text-xs text-muted-foreground truncate">
                          {course.teacher.realName}
                        </div>
                      )}
                    </div>

                    {/* Status badge */}
                    <div>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                          sc.color,
                        )}
                      >
                        {sc.label}
                      </span>
                    </div>

                    {/* Enrollments */}
                    <div className="text-center text-xs text-muted-foreground">
                      {course._count.enrollments}
                    </div>

                    {/* Lessons */}
                    <div className="text-center text-xs text-muted-foreground">
                      {course._count.lessons}
                    </div>

                    {/* Materials */}
                    <div className="text-center text-xs text-muted-foreground">
                      {course._count.materials}
                    </div>

                    {/* Created date */}
                    <div className="text-right text-xs text-muted-foreground">
                      {createdDate}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={14} className="mr-1" />
              上一页
            </Button>
            <div className="flex items-center gap-1.5">
              {getVisiblePages(pagination.page, pagination.totalPages).map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  disabled={loading}
                  onClick={() => setPage(pageNumber)}
                  className={cn(
                    "h-8 min-w-8 rounded-md border px-2 text-xs font-medium transition-colors",
                    pagination.page === pageNumber
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {pageNumber}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground text-xs">
                第 {pagination.page} / {pagination.totalPages} 页
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pagination.totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
                <ChevronRight size={14} className="ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
