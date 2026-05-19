"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MessageSquarePlus, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ClosedPanelInfo } from "@/components/PersonalKnowledgeBaseDockview";

const PersonalKnowledgeBaseDockview = dynamic(
  () => import("@/components/PersonalKnowledgeBaseDockview"),
  { ssr: false },
);

export default function PersonalKbPage() {
  const [closedPanels, setClosedPanels] = useState<ClosedPanelInfo[]>([]);
  const restorePanelFnRef = useRef<((info: ClosedPanelInfo) => void) | null>(null);

  return (
    <div className="flex flex-col h-full w-full min-h-0 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-background/80 backdrop-blur-sm px-4 py-3 shrink-0">
        <h2 className="font-display text-sm font-semibold text-foreground">个人知识库</h2>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs shrink-0"
                title="显示已关闭的面板"
              >
                <PanelLeftOpen size={14} />
                显示面板{closedPanels.length > 0 ? ` (${closedPanels.length})` : ""}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1.5">
              {closedPanels.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-1.5">所有面板均已显示</p>
              ) : (
                closedPanels.map((panel) => (
                  <button
                    key={panel.id}
                    type="button"
                    className="w-full text-left text-sm px-2 py-1.5 rounded-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                    onClick={() => restorePanelFnRef.current?.(panel)}
                  >
                    {panel.title}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs shrink-0"
            title="新建一个独立的问答窗口（标签页形式）"
            onClick={() => window.dispatchEvent(new CustomEvent("edu:new-personal-kb-chat-window"))}
          >
            <MessageSquarePlus size={14} />
            新建对话窗口
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <PersonalKnowledgeBaseDockview
          onClosedPanelsChange={setClosedPanels}
          restorePanelFnRef={restorePanelFnRef}
        />
      </div>
    </div>
  );
}
