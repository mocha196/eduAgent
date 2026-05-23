"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTheme } from "next-themes";
import type { DockviewIDisposable, IDockviewPanel } from "dockview";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { cn } from "@/lib/utils";
import { X, FileText, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import Image from "next/image";
import ChatComponent from "@/components/ChatComponent";
import CourseMaterialList from "@/components/CourseMaterialList";
import CourseMaterialViewer from "@/components/CourseMaterialViewer";
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMathDelimiters,
} from "@/lib/markdownMath";
import { markdownComponents } from "@/lib/markdownComponents";

type CitationPreview = {
  materialId: string;
  chunkId?: string;
  sourceLabel?: string;
  chunkText?: string;
  image_urls?: Array<{ page_idx: number; url: string }>;
};

type CourseChatCtx = {
  courseId: string;
  activeMaterialId: string | null;
  onPickMaterial: (id: string) => void;
  citation: CitationPreview | null;
  /** Capture the currently viewed material page as a File. Returns null when no capturable material is active. */
  captureCurrentPage: () => Promise<File | null>;
  /** Called by MaterialPreviewPanel to register/unregister the current capture function. */
  setPageCaptureFn: (fn: (() => Promise<File | null>) | null) => void;
};

const CourseChatCtx = createContext<CourseChatCtx | null>(null);

function useCourseChatCtx(): CourseChatCtx {
  const v = useContext(CourseChatCtx);
  if (!v) throw new Error("CourseChatDockview context missing");
  return v;
}

function dockviewLayoutKey(courseId: string): string {
  return `edu:course-chat:dockview:${courseId}`;
}

function defaultThreeColumnLayout(api: DockviewApi, defaultSessionId: string | null = null): void {
  const list = api.addPanel({
    id: "materialList",
    component: "materialList",
    title: "资料列表",
  });
  const preview = api.addPanel({
    id: "materialPreview",
    component: "materialPreview",
    title: "资料预览",
    position: { referencePanel: list, direction: "right" },
  });
  api.addPanel({
    id: "chat",
    component: "chat",
    title: "课程问答",
    params: { sessionId: defaultSessionId },
    position: { referencePanel: preview, direction: "right" },
  });
}

function isPersistedDockviewLayout(
  x: unknown,
): x is Parameters<DockviewApi["fromJSON"]>[0] {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.grid === "object" &&
    o.grid !== null &&
    typeof o.panels === "object" &&
    o.panels !== null
  );
}

function MaterialListPanel() {
  const { courseId, activeMaterialId, onPickMaterial } = useCourseChatCtx();
  return (
    <CourseMaterialList
      courseId={courseId}
      activeMaterialId={activeMaterialId}
      onPickMaterial={onPickMaterial}
    />
  );
}

function MaterialPreviewPanel() {
  const { courseId, activeMaterialId, citation, setPageCaptureFn } = useCourseChatCtx();
  return (
    <CourseMaterialViewer
      courseId={courseId}
      materialId={activeMaterialId}
      chunkId={citation?.chunkId}
      sourceLabel={citation?.sourceLabel}
      onCaptureFnChange={setPageCaptureFn}
    />
  );
}

function ChatPanel(props: IDockviewPanelProps<{ sessionId?: string | null }>) {
  const { courseId, activeMaterialId, captureCurrentPage } = useCourseChatCtx();
  return (
    <ChatComponent
      courseId={courseId}
      hydrateSessionId={props.params?.sessionId ?? null}
      activeMaterialId={activeMaterialId}
      captureCurrentPage={captureCurrentPage}
    />
  );
}

const dockviewComponents = {
  materialList: MaterialListPanel,
  materialPreview: MaterialPreviewPanel,
  chat: ChatPanel,
};

export type ClosedPanelInfo = {
  id: string;
  title: string;
  component: string;
  params?: Record<string, unknown>;
};

type Props = {
  courseId: string;
  onClosedPanelsChange?: (panels: ClosedPanelInfo[]) => void;
  restorePanelFnRef?: React.MutableRefObject<((info: ClosedPanelInfo) => void) | null>;
};

export default function CourseChatDockview({ courseId, onClosedPanelsChange, restorePanelFnRef }: Props) {
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(
    null,
  );
  const [citation, setCitation] = useState<CitationPreview | null>(null);
  const [citationTextPanel, setCitationTextPanel] = useState<CitationPreview | null>(null);
  const [citationListPanel, setCitationListPanel] = useState<CitationPreview[] | null>(null);
  const { resolvedTheme } = useTheme();

  // Closed-panels tracking
  const [, setClosedPanels] = useState<ClosedPanelInfo[]>([]);
  const closedPanelsRef = useRef<ClosedPanelInfo[]>([]);
  const onClosedPanelsChangeCbRef = useRef(onClosedPanelsChange);
  onClosedPanelsChangeCbRef.current = onClosedPanelsChange;

  const setClosedPanelsAndNotify = useCallback((panels: ClosedPanelInfo[]) => {
    closedPanelsRef.current = panels;
    setClosedPanels(panels);
    onClosedPanelsChangeCbRef.current?.(panels);
  }, []);

  const restorePanel = useCallback((info: ClosedPanelInfo) => {
    const api = apiRef.current;
    if (!api) return;
    const refPanel = api.panels[api.panels.length - 1];
    api.addPanel({
      id: info.id,
      component: info.component,
      title: info.title,
      params: info.params,
      position: refPanel ? { referencePanel: refPanel.id, direction: "within" } : undefined,
    });
  }, []);

  useEffect(() => {
    if (restorePanelFnRef) restorePanelFnRef.current = restorePanel;
    return () => { if (restorePanelFnRef) restorePanelFnRef.current = null; };
  }, [restorePanelFnRef, restorePanel]);

  // Holds the agentSessionId of the default (oldest) course chat session.
  // Updated after async fetch; used to inject into the default "chat" panel and re-injected after layout reset.
  const defaultSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    defaultSessionIdRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/courses/${encodeURIComponent(courseId)}/chat/session`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { sessions?: { session_id: string }[] };
        const sid = body.sessions?.[0]?.session_id ?? null;
        if (cancelled) return;
        defaultSessionIdRef.current = sid;
        // Inject sessionId into the default "chat" panel (may not exist yet if dockview hasn't mounted)
        apiRef.current?.getPanel("chat")?.api.updateParameters({ sessionId: sid });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const apiRef = useRef<DockviewApi | null>(null);
  const layoutDisposableRef = useRef<DockviewIDisposable | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resettingLayoutRef = useRef(false);

  const resetDockviewToDefault = useCallback((api: DockviewApi) => {
    const storageKey = dockviewLayoutKey(courseId);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    setClosedPanelsAndNotify([]);
    resettingLayoutRef.current = true;
    try {
      api.clear();
      defaultThreeColumnLayout(api);
      // Re-inject the default session ID into the freshly-created chat panel
      const sid = defaultSessionIdRef.current;
      if (sid) {
        api.getPanel("chat")?.api.updateParameters({ sessionId: sid });
      }
    } finally {
      resettingLayoutRef.current = false;
    }
  }, [courseId, setClosedPanelsAndNotify]);

  const handleAddChatWindow = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const res = await fetch(
        `/api/v1/courses/${encodeURIComponent(courseId)}/chat/session`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { session_id?: string };
      const newSessionId = body.session_id;
      if (!newSessionId) return;
      const chatPanels = api.panels.filter((p) => p.id.startsWith("chat"));
      const refPanelId = chatPanels[chatPanels.length - 1]?.id ?? "chat";
      const shortId = newSessionId.replace(/-/g, "").slice(0, 8);
      api.addPanel({
        id: `chat_${shortId}`,
        component: "chat",
        title: "新对话",
        params: { sessionId: newSessionId },
        position: { referencePanel: refPanelId, direction: "within" },
      });
    } catch {
      /* ignore */
    }
  }, [courseId]);

  useEffect(() => {
    const h = (ev: Event) => {
      const ce = ev as CustomEvent<{ courseId?: string }>;
      if (ce.detail?.courseId !== courseId) return;
      void handleAddChatWindow();
    };
    window.addEventListener("edu:new-course-chat-window", h as EventListener);
    return () =>
      window.removeEventListener("edu:new-course-chat-window", h as EventListener);
  }, [courseId, handleAddChatWindow]);

  useEffect(() => {
    const h = (ev: Event) => {
      const ce = ev as CustomEvent<CitationPreview>;
      if (ce.detail?.materialId) {
        setCitation(ce.detail);
        setSelectedMaterialId(ce.detail.materialId);
        setCitationTextPanel(ce.detail);
      }
    };
    window.addEventListener("edu:open-material-preview", h as EventListener);
    return () =>
      window.removeEventListener(
        "edu:open-material-preview",
        h as EventListener,
      );
  }, []);

  useEffect(() => {
    const h = (ev: Event) => {
      const ce = ev as CustomEvent<CitationPreview[]>;
      if (Array.isArray(ce.detail) && ce.detail.length > 0) {
        setCitationListPanel(ce.detail);
        setCitationTextPanel(null);
      }
    };
    window.addEventListener("edu:open-citation-list", h as EventListener);
    return () => window.removeEventListener("edu:open-citation-list", h as EventListener);
  }, []);

  useEffect(() => {
    const h = (ev: Event) => {
      const ce = ev as CustomEvent<{ courseId?: string }>;
      if (ce.detail?.courseId !== courseId) return;
      const api = apiRef.current;
      if (!api) return;
      resetDockviewToDefault(api);
    };
    window.addEventListener("edu:reset-course-chat-dockview", h as EventListener);
    return () =>
      window.removeEventListener(
        "edu:reset-course-chat-dockview",
        h as EventListener,
      );
  }, [courseId, resetDockviewToDefault]);

  const activeMaterialId = citation?.materialId ?? selectedMaterialId;

  const onPickMaterial = useCallback((mid: string) => {
    setSelectedMaterialId(mid);
    setCitation(null);
  }, []);

  // Ref holding the capture function registered by the active MaterialPreviewPanel.
  // Updated by CourseMaterialViewer via onCaptureFnChange; read by ChatPanel before sending.
  const pageCaptureFnRef = useRef<(() => Promise<File | null>) | null>(null);

  const setPageCaptureFn = useCallback((fn: (() => Promise<File | null>) | null) => {
    pageCaptureFnRef.current = fn;
  }, []);

  const ctxValue = useMemo<CourseChatCtx>(
    () => ({
      courseId,
      activeMaterialId,
      onPickMaterial,
      citation,
      captureCurrentPage: async () => pageCaptureFnRef.current?.() ?? null,
      setPageCaptureFn,
    }),
    [courseId, activeMaterialId, onPickMaterial, citation, setPageCaptureFn],
  );

  const dockTheme = resolvedTheme === "dark" ? themeDark : themeLight;

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateOptions({ theme: dockTheme });
  }, [dockTheme]);

  useEffect(
    () => () => {
      layoutDisposableRef.current?.dispose();
      layoutDisposableRef.current = null;
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      apiRef.current = null;
    },
    [courseId],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const { api } = event;
      apiRef.current = api;

      layoutDisposableRef.current?.dispose();
      layoutDisposableRef.current = null;
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }

      const storageKey = dockviewLayoutKey(courseId);
      let loaded = false;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (isPersistedDockviewLayout(parsed)) {
            try {
              api.fromJSON(parsed);
              loaded = true;
            } catch {
              try {
                localStorage.removeItem(storageKey);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* ignore */
        }
      }

      if (!loaded) {
        api.clear();
        defaultThreeColumnLayout(api);
      } else if (api.panels.length === 0) {
        resetDockviewToDefault(api);
      }

      const schedulePersist = () => {
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
        persistTimerRef.current = setTimeout(() => {
          persistTimerRef.current = null;
          if (api.totalPanels === 0) {
            try {
              localStorage.removeItem(storageKey);
            } catch {
              /* ignore */
            }
            return;
          }
          try {
            localStorage.setItem(storageKey, JSON.stringify(api.toJSON()));
          } catch {
            /* ignore */
          }
        }, 400);
      };

      const layoutChangeSub = api.onDidLayoutChange(schedulePersist);
      const removePanelSub = api.onDidRemovePanel((panel: IDockviewPanel) => {
        if (resettingLayoutRef.current) return;
        const component = panel.id === "materialList" ? "materialList"
          : panel.id === "materialPreview" ? "materialPreview"
          : "chat";
        const info: ClosedPanelInfo = {
          id: panel.id,
          title: panel.title ?? panel.id,
          component,
          params: panel.params as Record<string, unknown> | undefined,
        };
        const prev = closedPanelsRef.current;
        if (!prev.some(p => p.id === info.id)) {
          setClosedPanelsAndNotify([...prev, info]);
        }
        if (api.panels.length === 0) {
          resetDockviewToDefault(api);
        }
      });
      const addPanelSub = api.onDidAddPanel((panel: IDockviewPanel) => {
        if (resettingLayoutRef.current) return;
        const prev = closedPanelsRef.current;
        const next = prev.filter(p => p.id !== panel.id);
        if (next.length !== prev.length) setClosedPanelsAndNotify(next);
      });
      layoutDisposableRef.current = {
        dispose() {
          layoutChangeSub.dispose();
          removePanelSub.dispose();
          addPanelSub.dispose();
        },
      };
    },
    [courseId, resetDockviewToDefault, setClosedPanelsAndNotify],
  );

  return (
    <CourseChatCtx.Provider value={ctxValue}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 min-h-0 min-w-0">
          <DockviewReact
            key={courseId}
            className="h-full min-h-0 flex-1"
            theme={dockTheme}
            components={dockviewComponents}
            onReady={onReady}
          />

          {/* Citation list panel — slides in from right, lists all citations */}
          <aside
            className={cn(
              "flex flex-col border-l border-border bg-background transition-[width,opacity] duration-200 ease-out shrink-0 overflow-hidden",
              citationListPanel
                ? "w-60 min-w-[200px] opacity-100"
                : "w-0 min-w-0 opacity-0",
            )}
          >
            {citationListPanel && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-muted/30">
                  <List size={13} className="text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium text-muted-foreground flex-1">
                    {citationListPanel.length} 个引用块
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    aria-label="关闭引用列表"
                    onClick={() => setCitationListPanel(null)}
                  >
                    <X size={15} />
                  </Button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <div className="flex flex-col divide-y divide-border">
                    {citationListPanel.map((c, ci) => (
                      <button
                        key={ci}
                        type="button"
                        onClick={() => {
                          setCitation(c);
                          setSelectedMaterialId(c.materialId);
                          setCitationTextPanel(c);
                        }}
                        className="flex flex-col items-start gap-1 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] font-bold text-primary/60">[{ci + 1}]</span>
                          <span className="text-[11px] font-medium text-foreground truncate max-w-[160px]">
                            {c.sourceLabel ?? `引用 ${ci + 1}`}
                          </span>
                        </div>
                        {c.chunkText && (
                          <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">
                            {c.chunkText.slice(0, 80)}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </aside>

          {/* Citation text panel — slides in from right alongside dockview */}
          <aside
            className={cn(
              "flex flex-col border-l border-border bg-background transition-[width,opacity] duration-200 ease-out shrink-0 overflow-hidden",
              citationTextPanel
                ? "w-[min(420px,44vw)] min-w-[280px] opacity-100"
                : "w-0 min-w-0 opacity-0",
            )}
          >
            {citationTextPanel && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-muted/30">
                  <span className="text-xs font-medium text-muted-foreground truncate flex-1">
                    {citationTextPanel.sourceLabel ?? "引用资料"}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    aria-label="关闭引用面板"
                    onClick={() => setCitationTextPanel(null)}
                  >
                    <X size={15} />
                  </Button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {citationTextPanel.chunkText ? (
                    <div className="p-4 space-y-4">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <FileText size={13} />
                        <span>检索文本块</span>
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg bg-muted/40 border border-border p-3 text-xs leading-relaxed">
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          components={markdownComponents}
                        >
                          {normalizeMathDelimiters(citationTextPanel.chunkText)}
                        </ReactMarkdown>
                      </div>
                      {(citationTextPanel.image_urls?.length ?? 0) > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">相关图片</p>
                          <div className="flex flex-col gap-3">
                            {citationTextPanel.image_urls!.map((img, idx) => (
                              <div key={idx} className="space-y-1">
                                <p className="text-[10px] text-muted-foreground">第 {img.page_idx + 1} 页</p>
                                <Image
                                  src={img.url}
                                  alt={`第 ${img.page_idx + 1} 页`}
                                  width={0}
                                  height={0}
                                  unoptimized
                                  style={{ width: "100%", height: "auto" }}
                                  className="rounded border border-border object-contain"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full min-h-[120px] text-muted-foreground text-xs gap-2 p-6 text-center">
                      <FileText size={24} className="opacity-40" />
                      <span>暂无文本块内容</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </CourseChatCtx.Provider>
  );
}
