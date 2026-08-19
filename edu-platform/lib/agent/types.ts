/**
 * Core types for the TS Agent (Phase 3B).
 */

import type { B3CitationEvent } from "./b3-protocol";

export type { B3SseEvent } from "./b3-protocol";

// ---- Message ----------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type Message = {
  role: MessageRole;
  content: string;
  /** Present when role === "tool" */
  tool_call_id?: string;
  /** Present when role === "assistant" and contains tool calls */
  tool_calls?: ToolCall[];
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
};
// ---- Tool -------------------------------------------------------------------

export type JSONSchema = Record<string, unknown>;

/** Rich result from a tool that wants to emit citation events. */
export type ToolCitation = Omit<B3CitationEvent, "type">;

export type ToolResult = {
  /** Text returned to the LLM */
  content: string;
  /** Optional citations emitted as SSE events */
  citations?: ToolCitation[];
  /** Optional structured metadata emitted in the tool_result SSE event (e.g. decomposition info for knowledge_query). */
  meta?: Record<string, unknown>;
};

export type ToolCategory = "read" | "write" | "external" | "dangerous";

export type Tool = {
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * Execute the tool with the given parsed arguments.
   * Return a plain string or a ToolResult with optional citations.
   */
  execute: (args: Record<string, unknown>, ctx: TurnContext) => Promise<string | ToolResult>;
  /** Whether this tool requires explicit user approval before execution. */
  requiresApproval?: boolean;
  /** Human-readable reason shown to the user when requesting approval. */
  approvalReason?: string;
  /** Categorises the tool's side-effect level for UI display. */
  category?: ToolCategory;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
};

// ---- Context ----------------------------------------------------------------

/** Pre-fetched material info injected into the system prompt when the user is previewing a material. */
export type MaterialContext = {
  materialId: string;
  filename: string;
  fileType: string;
  videoSummary: string | null;
  documentSummary: string | null;
};

export type TurnContext = {
  userId: string;
  sessionId: string;
  accessibleCourseIds: string[];
  courseId?: string | null;
  lessonId?: string | null;
  traceId?: string | null;
  debugTrace?: boolean;
  /** When set, indicates this turn is for a personal KB chat; RAG tools should query the user's personal workspace. */
  personalKbUserId?: string | null;
  /** ID of the material the user is currently previewing (passed from frontend). Used by tools. */
  materialId?: string | null;
  /** Pre-fetched material metadata for system prompt injection. Populated by chatService when materialId is present. */
  materialContext?: MaterialContext | null;
  /**
   * Implicit page-context image captured silently when the user sent this message.
   * Not shown in UI. The LLM accesses it only by calling `view_current_material_page`.
   */
  currentPageImage?: { presigned_url: string; mime_type: string; name: string } | null;
  /** When true, this turn is an automated eval run. Tools may use this to restrict behaviour (e.g. force sources="course"). */
  evalMode?: boolean;
  /**
   * Progress callback injected by the ReAct loop before tool execution.
   * Tools call this to emit real-time status labels visible in the chat UI.
   */
  onProgress?: (label: string) => Promise<void>;
  /** Attachment metadata passed from the frontend for the current turn. Used by read_attachment tool. */
  attachments?: Array<{
    id: string;
    presigned_url: string;
    mime_type: string;
    name: string;
  }>;
};

// ---- Agent config -----------------------------------------------------------

export type AgentConfig = {
  model: string;
  systemPrompt: string;
  maxIterations: number;
  /** RAG Service base URL, e.g. http://localhost:8001 */
  ragServiceUrl: string;
  /** X-Internal-Key for RAG Service */
  ragServiceKey: string;
  /** Max context tokens before compression */
  maxContextTokens: number;
  /** Attachment URLs to include in the first user message */
  attachments?: Array<{
    id: string;
    presigned_url: string;
    mime_type: string;
    name: string;
  }>;
  /**
   * Controls approval behaviour for tools with requiresApproval=true.
   * - "require_user": pause the loop and wait for user confirmation (default for chat).
   * - "auto": skip approval and execute immediately (used by cron worker).
   */
  approvalMode?: "require_user" | "auto";
};
