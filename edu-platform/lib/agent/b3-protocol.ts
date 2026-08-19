import { z } from "zod";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const citationImageSchema = z.object({
  page_idx: z.number().int(),
  url: z.string(),
});

export const executionPayloadSchema = z.object({
  language: z.enum(["python", "javascript"]),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  return_code: z.number().int(),
});

const textEventSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

const citationEventSchema = z.object({
  type: z.literal("citation"),
  chunk_id: z.string().optional(),
  material_id: z.string().optional(),
  source_label: z.string().optional(),
  chunk_text: z.string().optional(),
  /** Full chunk text used by evaluation jobs. It is not rendered in the UI. */
  eval_text: z.string().optional(),
  image_urls: z.array(citationImageSchema).optional(),
});

const toolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  name: z.string().min(1),
  tool_call_id: z.string().optional(),
  input: jsonRecordSchema.optional(),
});

const toolProgressEventSchema = z.object({
  type: z.literal("tool_progress"),
  tool_call_id: z.string(),
  label: z.string(),
});

const toolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  name: z.string().min(1),
  tool_call_id: z.string().optional(),
  success: z.boolean().optional(),
  duration_ms: z.number().nonnegative().optional(),
  output: z.string().optional(),
  execution: executionPayloadSchema.optional(),
  meta: jsonRecordSchema.optional(),
});

const doneEventSchema = z.object({
  type: z.literal("done"),
  tokens: z.number().int().nonnegative().nullable().optional(),
  exec_time_ms: z.number().nonnegative().nullable().optional(),
  error: z.string().optional(),
});

const traceEventSchema = z.object({
  type: z.literal("trace"),
  trace_id: z.string().optional(),
  event: z.string().optional(),
  turn_id: z.string().optional(),
  ts: z.string().optional(),
  payload: jsonRecordSchema.optional(),
});

const requireApprovalEventSchema = z.object({
  type: z.literal("require_approval"),
  tool_call_id: z.string(),
  tool_name: z.string().min(1),
  args_preview: jsonRecordSchema,
  approval_key: z.string().min(1),
  reason: z.string(),
  /** Full, untruncated source for run_script approvals. */
  full_code: z.string().optional(),
});

const approvalResolvedEventSchema = z.object({
  type: z.literal("approval_resolved"),
  tool_call_id: z.string(),
  approved: z.boolean(),
});

/**
 * Canonical runtime contract for the B3 SSE protocol shared by the agent,
 * persistence transform, browser client, and evaluation scripts.
 */
export const b3SseEventSchema = z.discriminatedUnion("type", [
  textEventSchema,
  citationEventSchema,
  toolCallEventSchema,
  toolProgressEventSchema,
  toolResultEventSchema,
  doneEventSchema,
  traceEventSchema,
  requireApprovalEventSchema,
  approvalResolvedEventSchema,
]);

export type ExecutionPayload = z.infer<typeof executionPayloadSchema>;
export type B3SseEvent = z.infer<typeof b3SseEventSchema>;
export type B3CitationEvent = Extract<B3SseEvent, { type: "citation" }>;

/** Validate an already-decoded value received at a protocol boundary. */
export function parseB3SseEvent(value: unknown): B3SseEvent | null {
  const result = b3SseEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Parse and validate a JSON payload from an SSE `data:` line. */
export function parseB3SseEventJson(raw: string): B3SseEvent | null {
  try {
    return parseB3SseEvent(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
