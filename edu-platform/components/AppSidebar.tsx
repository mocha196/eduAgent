"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Blocks,
  BookOpen,
  Sparkles,
  GraduationCap,
  MessageSquare,
  LogOut,
  User,
  Users,
  Brain,
  ChevronRight,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/useNotifications";
import { NotificationPanel } from "@/components/NotificationPanel";

type UserInfo = {
  id: string;
  username: string;
  role: string;
  real_name: string | null;
};

const navItems = [
  { label: "课程管理", href: "/admin/courses", icon: BookOpen, roles: ["ADMIN"] },
  { label: "用户管理", href: "/admin/users", icon: Users, roles: ["ADMIN"] },
  { label: "课程空间", href: "/courses", icon: BookOpen, roles: ["STUDENT", "TEACHER"] },
  {
    label: "问答中心",
    href: "/me/qa-center",
    icon: MessageSquare,
    roles: ["STUDENT", "TEACHER"],
  },
  {
    label: "个人知识库",
    href: "/me/personal-kb",
    icon: Brain,
    roles: ["STUDENT", "TEACHER"],
  },
  { label: "个人中心", href: "/user", icon: User, roles: ["STUDENT", "TEACHER"] },
  { label: "长期记忆", href: "/me/memories", icon: Brain, roles: ["STUDENT", "TEACHER"] },
  { label: "技能管理", href: "/admin/skills", icon: Blocks, roles: ["ADMIN"] },
  { label: "风格管理", href: "/admin/styles", icon: Sparkles, roles: ["ADMIN"] },
];

const roleLabels: Record<string, string> = {
  STUDENT: "学生",
  TEACHER: "教师",
  ADMIN: "管理员",
};

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isMobile } = useSidebar();
  /** Desktop icon rail only; mobile sheet always uses expanded header chrome */
  const isCollapsed = state === "collapsed" && !isMobile;
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();

  useEffect(() => {
    void fetch("/api/v1/user", { credentials: "include" })
      .then((r) => r.json())
      .then((d: UserInfo) => setUser(d))
      .catch(() => null);
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/v1/logout", { method: "POST", credentials: "include" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  const visibleNavItems = navItems.filter((item) => {
    if (!item.roles) return true;
    if (!user) return false;
    return item.roles.includes(user.role);
  });

  return (
    <>
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      {/* Header */}
      <SidebarHeader className={cn("py-4", isCollapsed ? "px-2" : "px-3")}>
        {isCollapsed ? (
          <div className="flex justify-center">
            <div className="group/brand relative flex size-8 shrink-0 items-center justify-center">
              <SidebarTrigger
                title="展开侧边栏"
                className={cn(
                  "absolute inset-0 z-0 size-8 shrink-0 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                  "opacity-0 transition-opacity",
                  "group-hover/brand:opacity-100 group-focus-within/brand:opacity-100"
                )}
              />
              <div
                className={cn(
                  "pointer-events-none relative z-10 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-opacity",
                  "group-hover/brand:opacity-0 group-focus-within/brand:opacity-0"
                )}
              >
                <GraduationCap size={16} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <GraduationCap size={16} />
            </div>
            <div className="flex flex-col leading-none">
              <span className="font-display text-sm font-semibold tracking-tight text-sidebar-foreground">
                EduAgent
              </span>
              <span className="text-[10px] text-muted-foreground">Campus</span>
            </div>
            <div className="ml-auto">
              <SidebarTrigger className="h-6 w-6 text-muted-foreground hover:text-foreground" />
            </div>
          </div>
        )}
      </SidebarHeader>

      {/* Navigation */}
      <SidebarContent className={cn("px-2", isCollapsed && "px-0")}>
        <SidebarGroup>
          {!isCollapsed && (
            <SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 px-2 mb-1">
              导航
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {visibleNavItems.map((item) => {
                const isActive =
                  item.href === "/courses"
                    ? pathname === "/courses" || pathname.startsWith("/courses/")
                    : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={isCollapsed ? item.label : undefined}
                      className={cn(
                        "h-9 gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-all",
                        isCollapsed && "justify-center",
                        isActive
                          ? "bg-accent text-accent-foreground font-semibold"
                          : "text-sidebar-foreground hover:bg-accent/60 hover:text-accent-foreground"
                      )}
                    >
                      <Link href={item.href}>
                        <item.icon
                          size={16}
                          className={cn(
                            "shrink-0",
                            isActive ? "text-primary" : "text-muted-foreground"
                          )}
                        />
                        {!isCollapsed && <span>{item.label}</span>}
                        {!isCollapsed && isActive && (
                          <ChevronRight size={12} className="ml-auto text-primary opacity-60" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer */}
      <SidebarFooter
        className={cn(
          "border-t border-sidebar-border py-3",
          isCollapsed ? "px-2" : "px-3"
        )}
      >
        <div className="flex flex-col gap-2">
          {/* User info */}
          {user && (
            <div
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2 py-1.5",
                isCollapsed ? "justify-center" : ""
              )}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-semibold">
                {(user.real_name ?? user.username).charAt(0).toUpperCase()}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col leading-tight min-w-0">
                  <span className="truncate text-[13px] font-medium text-sidebar-foreground">
                    {user.real_name ?? user.username}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {roleLabels[user.role] ?? user.role}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className={cn("flex gap-1.5", isCollapsed ? "flex-col items-center" : "")}>
            {/* Notifications bell */}
            <button
              onClick={() => setNotifOpen(true)}
              title="通知"
              className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Bell size={15} />
              {unreadCount > 0 && (
                <span className="absolute right-1 top-1 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold leading-none text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
            {/* Logout */}
            <button
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              title="退出登录"
              className={cn(
                "flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors",
                isCollapsed ? "w-8 justify-center" : "flex-1"
              )}
            >
              <LogOut size={15} className="shrink-0" />
              {!isCollapsed && <span>{loggingOut ? "退出中…" : "退出登录"}</span>}
            </button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>

    <NotificationPanel
      open={notifOpen}
      onClose={() => setNotifOpen(false)}
      notifications={notifications}
      onMarkRead={markRead}
      onMarkAllRead={markAllRead}
    />
  </>
  );
}
