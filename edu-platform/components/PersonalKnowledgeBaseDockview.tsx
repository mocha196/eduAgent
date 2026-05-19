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
import ChatComponent from "@/components/ChatComponent";
import PersonalMaterialList from "@/components/PersonalMaterialList";
import CourseMaterialViewer from "@/components/CourseMaterialViewer";
import PersonalMaterialUpload from "@/components/PersonalMaterialUpload";

const STORAGE_KEY = "edu:personal-kb:dockview";
const PERSONAL_MATERIALS_API_BASE = "/api/v1/me/materials";

export type ClosedPanelInfo = {
  id: string;
  title: string;
  component: string;
  params?: Record<string, unknown>;
};

type Props = {
  onClosedPanelsChange?: (panels: ClosedPanelInfo[]) => void;
  restorePanelFnRef?: React.MutableRefObject<((info: ClosedPanelInfo) => void) | null>;
};

type PersonalKbCtx = {
  activeMaterialId: string | null;
  onPickMaterial: (id: string) => void;
  sessionId: string | null;
  refreshList: () => void;
  listKey: number;
};

const PersonalKbCtx = createContext<PersonalKbCtx | null>(null);

function usePersonalKbCtx(): PersonalKbCtx {
  const v = useContext(PersonalKbCtx);
  if (!v) throw new Error("PersonalKnowledgeBaseDockview context missing");
  return v;
}

function isPersistedLayout(x: unknown): x is Parameters<DockviewApi["fromJSON"]>[0] {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.grid === "object" && o.grid !== null && typeof o.panels === "object" && o.panels !== null;
}

function defaultLayout(api: DockviewApi, defaultSessionId: string | null = null): void {
  const list = api.addPanel({ id: "materialList", component: "materialList", title: "我的资料" });
  const preview = api.addPanel({
    id: "materialPreview", component: "materialPreview", title: "资料预览",
    position: { referencePanel: list, direction: "right" },
  });
  api.addPanel({
    id: "chat", component: "chat", title: "个人知识库问答",
    params: { sessionId: defaultSessionId },
    position: { referencePanel: preview, direction: "right" },
  });
}

function MaterialListPanel() {
  const { activeMaterialId, onPickMaterial, refreshList, listKey } = usePersonalKbCtx();
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-2 pt-2 pb-1 border-b border-border flex justify-end">
        <PersonalMaterialUpload onUploaded={refreshList} />
      </div>
      <div className="flex-1 min-h-0">
        <PersonalMaterialList key={listKey} activeMaterialId={activeMaterialId} onPickMaterial={onPickMaterial} />
      </div>
    </div>
  );
}

function MaterialPreviewPanel() {
  const { activeMaterialId } = usePersonalKbCtx();
  return (
    <CourseMaterialViewer
      materialId={activeMaterialId}
      apiBase={PERSONAL_MATERIALS_API_BASE}
    />
  );
}

function ChatPanel(props: IDockviewPanelProps<{ sessionId?: string | null }>) {
  const { sessionId: ctxSessionId, activeMaterialId } = usePersonalKbCtx();
  const sessionId = props.params?.sessionId ?? ctxSessionId;
  return (
    <ChatComponent
      variant="personal_kb"
      sessionId={sessionId}
      activeMaterialId={activeMaterialId}
      emptyHint="向助手提问，将检索你的个人知识库"
    />
  );
}

const dockviewComponents = {
  materialList: MaterialListPanel,
  materialPreview: MaterialPreviewPanel,
  chat: ChatPanel,
};

export default function PersonalKnowledgeBaseDockview({ onClosedPanelsChange, restorePanelFnRef }: Props) {
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);
  const { resolvedTheme } = useTheme();
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutDisposableRef = useRef<DockviewIDisposable | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultSessionIdRef = useRef<string | null>(null);
  const resettingLayoutRef = useRef(false);

  // Closed-panels tracking
  const [closedPanels, setClosedPanels] = useState<ClosedPanelInfo[]>([]);
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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/v1/me/personal-kb/session", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { agent_session_id?: string };
        if (body.agent_session_id) {
          defaultSessionIdRef.current = body.agent_session_id;
          setSessionId(body.agent_session_id);
          apiRef.current?.getPanel("chat")?.api.updateParameters({ sessionId: body.agent_session_id });
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const handleAddChatWindow = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const res = await fetch("/api/v1/me/personal-kb/session", { method: "POST", credentials: "include" });
      if (!res.ok) return;
      const body = (await res.json()) as { agent_session_id?: string };
      const newSessionId = body.agent_session_id;
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
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const h = () => { void handleAddChatWindow(); };
    window.addEventListener("edu:new-personal-kb-chat-window", h);
    return () => window.removeEventListener("edu:new-personal-kb-chat-window", h);
  }, [handleAddChatWindow]);

  const refreshList = useCallback(() => setListKey((k) => k + 1), []);

  const onPickMaterial = useCallback((mid: string) => {
    setSelectedMaterialId(mid);
  }, []);

  const ctxValue = useMemo<PersonalKbCtx>(
    () => ({ activeMaterialId: selectedMaterialId, onPickMaterial, sessionId, refreshList, listKey }),
    [selectedMaterialId, onPickMaterial, sessionId, refreshList, listKey],
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
      if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
      apiRef.current = null;
    },
    [],
  );

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const { api } = event;
    apiRef.current = api;

    layoutDisposableRef.current?.dispose();
    layoutDisposableRef.current = null;
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }

    let loaded = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (isPersistedLayout(parsed)) {
          try { api.fromJSON(parsed); loaded = true; } catch {
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
          }
        }
      }
    } catch {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }

    if (!loaded || api.panels.length === 0) {
      api.clear();
      defaultLayout(api, defaultSessionIdRef.current);
    }

    const schedulePersist = () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        if (api.totalPanels === 0) {
          try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
          return;
        }
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON())); } catch { /* ignore */ }
      }, 500);
    };

    const layoutSub = api.onDidLayoutChange(schedulePersist);

    const removeSub = api.onDidRemovePanel((panel: IDockviewPanel) => {
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
      if (prev.some(p => p.id === info.id)) return;
      setClosedPanelsAndNotify([...prev, info]);
    });

    const addSub = api.onDidAddPanel((panel: IDockviewPanel) => {
      if (resettingLayoutRef.current) return;
      const prev = closedPanelsRef.current;
      const next = prev.filter(p => p.id !== panel.id);
      if (next.length !== prev.length) setClosedPanelsAndNotify(next);
    });

    layoutDisposableRef.current = {
      dispose() {
        layoutSub.dispose();
        removeSub.dispose();
        addSub.dispose();
      },
    };
    api.updateOptions({ theme: dockTheme });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PersonalKbCtx.Provider value={ctxValue}>
      <DockviewReact
        className="h-full w-full"
        components={dockviewComponents}
        onReady={onReady}
        theme={dockTheme}
      />
    </PersonalKbCtx.Provider>
  );
}
