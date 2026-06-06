"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  /** Context passed to the AI suggestion API */
  aiContext?: {
    questionText: string;
    studentAnswer: string;
    score: number;
    maxScore: number;
  };
  disabled?: boolean;
}

/**
 * Textarea with VS Code-style inline AI ghost text completion.
 *
 * Behavior:
 * - User types → 500 ms debounce → POST /api/v1/ai/suggest-feedback
 * - Suggestion shown as faded text immediately after the cursor
 * - Tab or → at end-of-text  → accepts suggestion
 * - Escape or any other key  → dismisses suggestion
 */
export function GhostTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
  aiContext,
  disabled,
}: Props) {
  const [suggestion, setSuggestion] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const fetchSuggestion = useCallback(
    async (prefix: string) => {
      if (!aiContext || prefix.trim().length < 2) {
        setSuggestion("");
        return;
      }

      // Cancel previous in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      try {
        const res = await fetch("/api/v1/ai/suggest-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, ...aiContext }),
          signal: abortRef.current.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { suggestion?: string };
          setSuggestion(data.suggestion ?? "");
        }
      } catch {
        // AbortError or network error — silently ignore
      } finally {
        setLoading(false);
      }
    },
    [aiContext],
  );

  // Debounce trigger
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSuggestion("");
      return;
    }
    debounceRef.current = setTimeout(() => {
      void fetchSuggestion(value);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fetchSuggestion]);

  function acceptSuggestion() {
    if (!suggestion) return;
    onChange(value + suggestion);
    setSuggestion("");
  }

  function handleScroll() {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!suggestion) return;

    const el = e.currentTarget;
    const atEnd = el.selectionStart === el.value.length;

    if ((e.key === "Tab" || e.key === "ArrowRight") && atEnd) {
      e.preventDefault();
      acceptSuggestion();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setSuggestion("");
    }
    // Any other key → dismiss suggestion (will be re-fetched after debounce)
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Meta" && e.key !== "Alt") {
      setSuggestion("");
    }
  }

  return (
    <div className="relative">
      {/* Ghost text overlay — rendered behind the real textarea */}
      {suggestion && (
        <div
          ref={overlayRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words",
            "rounded-md border border-transparent px-3 py-2 text-sm leading-5",
          )}
          style={{ fontFamily: "inherit" }}
        >
          <span className="invisible">{value}</span>
          <span className="text-muted-foreground select-none opacity-50">{suggestion}</span>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={cn(
          "relative z-10 flex min-h-[60px] w-full rounded-md border border-input bg-transparent",
          "px-3 py-2 text-sm leading-5 shadow-sm placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 resize-y",
          className,
        )}
      />

      {/* Loading indicator */}
      {loading && (
        <span className="absolute bottom-2 right-2 text-[10px] text-muted-foreground/60 select-none pointer-events-none">
          AI…
        </span>
      )}

      {/* Hint */}
      {suggestion && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          按 <kbd className="rounded border px-1 py-0.5 text-[10px] font-mono">Tab</kbd> 接受建议，
          <kbd className="rounded border px-1 py-0.5 text-[10px] font-mono">Esc</kbd> 取消
        </p>
      )}
    </div>
  );
}
