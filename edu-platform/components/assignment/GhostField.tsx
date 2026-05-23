"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface GhostFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  /** If true, renders a <textarea>; otherwise an <input type="text">. */
  multiline?: boolean;
  disabled?: boolean;
  /**
   * Async function that returns the ghost-text suggestion for the given prefix.
   * Return an empty string to show no suggestion.
   */
  getSuggestion: (prefix: string) => Promise<string>;
  debounceMs?: number;
  minPrefixLength?: number;
}

/**
 * Input / Textarea with VS Code-style inline ghost-text AI completion.
 *
 * Behavior:
 * - After `debounceMs` ms of inactivity (and prefix ≥ minPrefixLength), calls `getSuggestion`.
 * - Suggestion shown as faded text immediately after the cursor (end-of-text only).
 * - Tab or → (when cursor is at end) → accepts suggestion.
 * - Escape → dismisses suggestion.
 * - Any other editing key → dismisses suggestion (re-fetched after next pause).
 */
export function GhostField({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
  multiline = false,
  disabled,
  getSuggestion,
  debounceMs = 700,
  minPrefixLength = 4,
}: GhostFieldProps) {
  const [suggestion, setSuggestion] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep a stable ref to the latest getSuggestion to avoid re-creating doFetch
  const getSuggestionRef = useRef(getSuggestion);
  useEffect(() => {
    getSuggestionRef.current = getSuggestion;
  });

  const doFetch = useCallback(async (prefix: string) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    try {
      const result = await getSuggestionRef.current(prefix);
      setSuggestion(result);
    } catch {
      // AbortError or network error — silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Trigger debounced fetch when value changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSuggestion("");
    if (!value.trim() || value.trim().length < minPrefixLength) return;
    debounceRef.current = setTimeout(() => void doFetch(value), debounceMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, doFetch, debounceMs, minPrefixLength]);

  function acceptSuggestion() {
    if (!suggestion) return;
    onChange(value + suggestion);
    setSuggestion("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
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
      return;
    }
    // Dismiss on any editing key (but keep suggestion alive during navigation)
    if (!["Shift", "Control", "Meta", "Alt", "CapsLock", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) {
      setSuggestion("");
    }
  }

  const sharedCls = cn(
    "relative z-10 w-full rounded-md border border-input bg-transparent",
    "px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    "disabled:cursor-not-allowed disabled:opacity-50",
    multiline ? "resize-none min-h-[60px] flex" : "h-9",
    className,
  );

  return (
    <div className="relative">
      {/* Ghost text overlay */}
      {suggestion && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-md border border-transparent",
            "px-3 py-2 text-sm",
            multiline
              ? "whitespace-pre-wrap break-words leading-[1.5] overflow-hidden"
              : "whitespace-pre overflow-hidden leading-[1.35rem]",
          )}
          style={{ fontFamily: "inherit" }}
        >
          <span className="invisible">{value}</span>
          <span className="text-muted-foreground/50 select-none">{suggestion}</span>
        </div>
      )}

      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          className={sharedCls}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={sharedCls}
        />
      )}

      {loading && (
        <span className="absolute bottom-2 right-2 z-20 text-[10px] text-muted-foreground/50 pointer-events-none select-none">
          AI…
        </span>
      )}
    </div>
  );
}
