import { describe, expect, it } from "vitest";
import {
  parseB3SseEvent,
  parseB3SseEventJson,
  type B3SseEvent,
} from "@/lib/agent/b3-protocol";

describe("B3 SSE protocol", () => {
  it.each<B3SseEvent>([
    { type: "text", content: "hello" },
    {
      type: "citation",
      chunk_id: "chunk-1",
      image_urls: [{ page_idx: 2, url: "https://example.test/page.png" }],
    },
    { type: "tool_call", name: "knowledge_query", tool_call_id: "tc-1", input: { question: "TCP" } },
    { type: "tool_progress", tool_call_id: "tc-1", label: "正在检索…" },
    {
      type: "tool_result",
      name: "run_script",
      tool_call_id: "tc-2",
      success: true,
      duration_ms: 12,
      execution: {
        language: "python",
        command: "python script.py",
        stdout: "ok",
        stderr: "",
        return_code: 0,
      },
      meta: { source: "test" },
    },
    { type: "done", tokens: 21, exec_time_ms: 120 },
    { type: "trace", event: "loop_start", payload: { sessionId: "s-1" } },
    {
      type: "require_approval",
      tool_call_id: "tc-2",
      tool_name: "run_script",
      args_preview: { language: "python" },
      approval_key: "agent:approval:s-1:tc-2",
      reason: "需要确认",
      full_code: "print('ok')",
    },
    { type: "approval_resolved", tool_call_id: "tc-2", approved: true },
  ])("accepts a valid $type event", (event) => {
    expect(parseB3SseEventJson(JSON.stringify(event))).toEqual(event);
  });

  it("rejects malformed JSON, unknown event types, and invalid payload fields", () => {
    expect(parseB3SseEventJson("{not-json")).toBeNull();
    expect(parseB3SseEvent({ type: "unknown", content: "x" })).toBeNull();
    expect(parseB3SseEvent({ type: "tool_call", tool_call_id: "tc-1" })).toBeNull();
    expect(
      parseB3SseEvent({
        type: "tool_result",
        name: "run_script",
        execution: {
          language: "python",
          command: "python script.py",
          stdout: "",
          stderr: "",
          return_code: "0",
        },
      }),
    ).toBeNull();
  });

  it("drops unknown fields while preserving the validated event", () => {
    expect(parseB3SseEvent({ type: "text", content: "hello", unexpected: true })).toEqual({
      type: "text",
      content: "hello",
    });
  });
});
