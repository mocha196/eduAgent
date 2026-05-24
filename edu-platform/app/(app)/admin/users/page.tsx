"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Users,
  Search,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  BookOpen,
  GraduationCap,
  UserX,
  UserCheck,
  ChevronLeft,
  ChevronRight,
  UserPlus,
  X,
  Copy,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterSelect } from "@/components/FilterSelect";

type UserRole = "STUDENT" | "TEACHER" | "ADMIN";

type UserItem = {
  id: string;
  username: string;
  role: UserRole;
  realName: string | null;
  isActive: boolean;
  createdAt: string;
  _count: {
    courseEnrollments: number;
    teacherCourses: number;
  };
};

type CreateForm = {
  role: "STUDENT" | "TEACHER";
  username: string;
  realName: string;
};

type Pagination = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function useNotify() {
  const [n, setN] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const notify = (type: "success" | "error", msg: string) => {
    setN({ type, msg });
    setTimeout(() => setN(null), 4000);
  };
  return { notification: n, notify };
}

const roleConfig: Record<UserRole, { label: string; icon: React.ElementType; color: string }> = {
  ADMIN: { label: "管理员", icon: ShieldCheck, color: "text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:text-violet-400" },
  TEACHER: { label: "教师", icon: BookOpen, color: "text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400" },
  STUDENT: { label: "学生", icon: GraduationCap, color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400" },
};

const ROLE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部角色" },
  { value: "STUDENT", label: "学生" },
  { value: "TEACHER", label: "教师" },
  { value: "ADMIN", label: "管理员" },
];

const ACTIVE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "true", label: "已激活" },
  { value: "false", label: "已禁用" },
];

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const { notification, notify } = useNotify();

  const [roleFilter, setRoleFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<UserItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdInfo, setCreatedInfo] = useState<{ username: string; password: string } | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>({
    role: "STUDENT", username: "", realName: "",
  });
  const [copied, setCopied] = useState(false);

  function getVisiblePages(currentPage: number, totalPages: number) {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 3) return [1, 2, 3, 4, 5];
    if (currentPage >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [currentPage - 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2];
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (roleFilter) sp.set("role", roleFilter);
      if (activeFilter) sp.set("isActive", activeFilter);
      if (search) sp.set("search", search);
      sp.set("page", String(page));

      const res = await fetch(`/api/v1/admin/users?${sp.toString()}`, { credentials: "include" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { notify("error", "加载失败"); return; }
      const data = (await res.json()) as { users: UserItem[]; pagination: Pagination };
      setUsers(data.users);
      setPagination(data.pagination);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFilter, activeFilter, search, page]);

  useEffect(() => { void load(); }, [load]);

  function applySearch() {
    setSearch(searchInput);
    setPage(1);
  }

  function openCreate() {
    setCreateForm({ role: "STUDENT", username: "", realName: "" });
    setCreatedInfo(null);
    setCopied(false);
    setShowCreate(true);
  }

  async function submitCreate() {
    const { role, username, realName } = createForm;
    const uname = username.trim();
    if (!uname) { notify("error", "请填写学号"); return; }
    setCreating(true);
    try {
      const body: Record<string, string> = { role, username: uname };
      if (realName.trim()) body.realName = realName.trim();
      const res = await fetch("/api/v1/admin/users", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { user?: { username: string }; initial_password?: string; message?: string };
      if (!res.ok) { notify("error", data.message ?? "创建失败"); return; }
      setCreatedInfo({ username: data.user!.username, password: data.initial_password! });
      void load();
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(user: UserItem) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/admin/users/${user.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string }; message?: string };
        notify("error", err.error?.message ?? err.message ?? "删除失败");
        return;
      }
      setDeleteTarget(null);
      notify("success", `账号 ${user.username} 已删除`);
      void load();
    } finally {
      setDeleting(false);
    }
  }

  function copyPassword(pwd: string) {
    void navigator.clipboard.writeText(pwd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function patchUser(userId: string, patch: { isActive?: boolean; role?: UserRole }) {
    setUpdatingId(userId);
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        notify("error", err.message ?? "操作失败");
        return;
      }
      const data = (await res.json()) as { user: UserItem };
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, ...data.user } : u))
      );
      notify("success", "已更新");
    } finally {
      setUpdatingId(null);
    }
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

      <div className="max-w-5xl mx-auto w-full px-6 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Users size={20} className="text-primary" />
              用户管理
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              查看、搜索并管理平台所有用户账号状态。
            </p>
          </div>
          <Button size="sm" onClick={openCreate} className="shrink-0">
            <UserPlus size={14} className="mr-1.5" />创建账号
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-end">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              type="text"
              placeholder="搜索学号或姓名…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              className="w-full rounded-lg border bg-background pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button size="sm" onClick={applySearch} variant="secondary">
            搜索
          </Button>

          {/* Role filter */}
          <FilterSelect
            options={ROLE_FILTERS}
            value={roleFilter}
            onChange={(v) => { setRoleFilter(v); setPage(1); }}
          />

          {/* Active filter */}
          <FilterSelect
            options={ACTIVE_FILTERS}
            value={activeFilter}
            onChange={(v) => { setActiveFilter(v); setPage(1); }}
          />
        </div>

        {/* Stats bar */}
        {pagination && !loading && (
          <p className="text-xs text-muted-foreground">
            共 <span className="font-medium text-foreground">{pagination.total}</span> 位用户
            {pagination.total > 0 &&
              `，当前第 ${(pagination.page - 1) * pagination.pageSize + 1}–${Math.min(
                pagination.page * pagination.pageSize,
                pagination.total
              )} 条`}
          </p>
        )}

        {/* Table */}
        <div className="rounded-xl border bg-card overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_80px_80px_160px] gap-0 border-b bg-muted/30 px-4 py-2.5 text-xs font-medium text-muted-foreground">
            <div>学号 / 姓名</div>
            <div>角色</div>
            <div className="text-center">课程数</div>
            <div className="text-center">状态</div>
            <div className="text-right">操作</div>
          </div>

          {loading ? (
            <div className="space-y-0 divide-y">
              {[1, 2, 3, 4, 5].map((k) => (
                <div key={k} className="grid grid-cols-[1fr_1fr_100px_80px_80px_120px] gap-0 px-4 py-3.5 items-center">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-5 w-14" />
                  <Skeleton className="h-4 w-8 mx-auto" />
                  <Skeleton className="h-5 w-12 mx-auto" />
                  <Skeleton className="h-7 w-24 ml-auto" />
                </div>
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              暂无符合条件的用户
            </div>
          ) : (
            <div className="divide-y">
              {users.map((user) => {
                const rc = roleConfig[user.role];
                const RoleIcon = rc.icon;
                const isSelf = false; // can't detect without current user id here, handled by API
                return (
                  <div
                    key={user.id}
                    className={cn(
                      "grid grid-cols-[1fr_100px_80px_80px_160px] gap-0 px-4 py-3 items-center text-sm transition-colors hover:bg-muted/20",
                      !user.isActive && "opacity-60",
                    )}
                  >
                    {/* Username (= 学号) + realName */}
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">{user.username}</div>
                      {user.realName && (
                        <div className="text-xs text-muted-foreground truncate">{user.realName}</div>
                      )}
                    </div>

                    {/* Role badge */}
                    <div>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          rc.color,
                        )}
                      >
                        <RoleIcon size={10} />
                        {rc.label}
                      </span>
                    </div>

                    {/* Course count */}
                    <div className="text-center text-xs text-muted-foreground">
                      {user.role === "STUDENT"
                        ? user._count.courseEnrollments
                        : user._count.teacherCourses}
                    </div>

                    {/* Active badge */}
                    <div className="flex justify-center">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                          user.isActive
                            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400"
                            : "bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400",
                        )}
                      >
                        {user.isActive ? "正常" : "禁用"}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={updatingId === user.id || deleting}
                        onClick={() => patchUser(user.id, { isActive: !user.isActive })}
                        className="h-7 px-2 text-xs"
                        title={user.isActive ? "禁用账号" : "激活账号"}
                      >
                        {user.isActive ? (
                          <><UserX size={12} className="mr-1" />禁用</>
                        ) : (
                          <><UserCheck size={12} className="mr-1" />激活</>
                        )}
                      </Button>
                      {user.role !== "ADMIN" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={updatingId === user.id || deleting}
                          onClick={() => setDeleteTarget(user)}
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                          title="删除账号"
                        >
                          <Trash2 size={12} />
                        </Button>
                      )}
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

      {/* Create User Dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}>
          <div className="w-full max-w-md rounded-2xl border bg-card shadow-xl p-6 space-y-5 mx-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">创建账号</h2>
              <button onClick={() => setShowCreate(false)} className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted">
                <X size={16} />
              </button>
            </div>

            {createdInfo ? (
              <div className="space-y-4">
                <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                    <CheckCircle2 size={16} />账号创建成功
                  </div>
                  <div className="text-sm space-y-1">
                    <p className="text-muted-foreground">学号：<span className="font-mono text-foreground">{createdInfo.username}</span></p>
                    <p className="text-muted-foreground flex items-center gap-2">初始密码：
                      <span className="font-mono text-foreground">{createdInfo.password}</span>
                      <button onClick={() => copyPassword(createdInfo.password)} className="text-primary hover:text-primary/80">
                        <Copy size={13} />
                      </button>
                      {copied && <span className="text-xs text-emerald-600">已复制</span>}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">请将账号信息告知用户，首次登录后建议修改密码。</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setCreatedInfo(null); setCreateForm({ role: "STUDENT", username: "", realName: "" }); }}>继续创建</Button>
                  <Button size="sm" onClick={() => setShowCreate(false)}>完成</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Role selector */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">角色</label>
                  <div className="flex gap-2">
                    {(["STUDENT", "TEACHER"] as const).map((r) => (
                      <button key={r} onClick={() => setCreateForm(f => ({ ...f, role: r }))}
                        className={cn("flex-1 rounded-lg border py-2 text-sm font-medium transition-colors",
                          createForm.role === r ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground")}>
                        {r === "STUDENT" ? "学生" : "教师"}
                      </button>
                    ))}
                  </div>
                </div>

                {createForm.role === "STUDENT" ? (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">学号 <span className="text-destructive">*</span></label>
                    <input value={createForm.username} onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))}
                      placeholder="例：20210001" className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    <p className="text-xs text-muted-foreground">登录学号即初始密码</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">学号 <span className="text-destructive">*</span></label>
                    <input value={createForm.username} onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))}
                      placeholder="登录学号" className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    <p className="text-xs text-muted-foreground">登录学号即初始密码</p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">姓名（可选）</label>
                  <input value={createForm.realName} onChange={e => setCreateForm(f => ({ ...f, realName: e.target.value }))}
                    placeholder="真实姓名" className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <Button size="sm" variant="secondary" onClick={() => setShowCreate(false)}>取消</Button>
                  <Button size="sm" onClick={submitCreate} disabled={creating}>
                    {creating ? "创建中…" : "创建账号"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirm Dialog */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setDeleteTarget(null); }}
        >
          <div className="w-full max-w-sm rounded-2xl border bg-card shadow-xl p-6 space-y-4 mx-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-destructive flex items-center gap-2">
                <Trash2 size={18} />删除账号
              </h2>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              确定要删除账号{" "}
              <span className="font-semibold text-foreground">{deleteTarget.username}</span>
              ？此操作不可撤销，该账号的所有学习记录将被清除。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                取消
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void deleteUser(deleteTarget)}
                disabled={deleting}
              >
                {deleting ? "删除中…" : "确认删除"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
