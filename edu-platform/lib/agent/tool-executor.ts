import type { Tool, ToolResult, TurnContext, JSONSchema } from "./types";
import {
  compileToolParameters,
  type ToolRegistry,
} from "./tool-registry";

export type ToolValidationIssue = {
  path: string;
  message: string;
};

export type ToolExecutionErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_NOT_ALLOWED"
  | "INVALID_JSON"
  | "INVALID_ARGUMENTS"
  | "EXECUTION_REJECTED"
  | "EXECUTION_ERROR";

export type ToolExecutionError = {
  code: ToolExecutionErrorCode;
  message: string;
  issues?: ToolValidationIssue[];
};

export type ToolExecutionResult =
  | {
      ok: true;
      tool: Tool;
      args: Record<string, unknown>;
      result: ToolResult;
    }
  | {
      ok: false;
      tool?: Tool;
      args?: Record<string, unknown>;
      error: ToolExecutionError;
    };

export type BeforeToolExecuteResult =
  | void
  | { allowed: true }
  | { allowed: false; message?: string };

export type ExecuteToolCallOptions = {
  registry: ToolRegistry;
  toolName: string;
  rawArguments: string;
  ctx: TurnContext;
  /** Enforced again at execution time; model-side schema filtering is not security. */
  allowedToolNames?: ReadonlySet<string>;
  /** Use when the model was shown a context-specific schema, e.g. eval mode. */
  parametersOverride?: JSONSchema;
  /** Approval/authorisation hook. It runs only after input validation succeeds. */
  beforeExecute?: (
    tool: Tool,
    args: Record<string, unknown>,
  ) => Promise<BeforeToolExecuteResult>;
};

/** The only supported boundary for executing an LLM-generated tool call. */
export async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecutionResult> {
  const {
    registry,
    toolName,
    rawArguments,
    ctx,
    allowedToolNames,
    parametersOverride,
    beforeExecute,
  } = options;

  if (allowedToolNames && !allowedToolNames.has(toolName)) {
    return {
      ok: false,
      error: {
        code: "TOOL_NOT_ALLOWED",
        message: `Tool "${toolName}" is not allowed in this run`,
      },
    };
  }

  const tool = registry.get(toolName);
  if (!tool) {
    return {
      ok: false,
      error: {
        code: "TOOL_NOT_FOUND",
        message: `Tool "${toolName}" not found in registry`,
      },
    };
  }

  let unknownArgs: unknown;
  try {
    unknownArgs = JSON.parse(rawArguments || "{}");
  } catch {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_JSON",
        message: "Tool arguments are not valid JSON",
      },
    };
  }

  const validator = parametersOverride
    ? compileToolParameters(parametersOverride)
    : registry.getValidator(toolName);
  if (!validator) {
    return {
      ok: false,
      tool,
      error: {
        code: "EXECUTION_ERROR",
        message: `Tool "${toolName}" has no compiled input validator`,
      },
    };
  }

  const validation = validator.safeParse(unknownArgs);
  if (!validation.success) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_ARGUMENTS",
        message: "Tool argument validation failed",
        issues: validation.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    };
  }

  const args = validation.data as Record<string, unknown>;
  try {
    const decision = await beforeExecute?.(tool, args);
    if (decision && decision.allowed === false) {
      return {
        ok: false,
        tool,
        args,
        error: {
          code: "EXECUTION_REJECTED",
          message: decision.message ?? "Tool execution was rejected",
        },
      };
    }

    const raw = await tool.execute(args, ctx);
    return {
      ok: true,
      tool,
      args,
      result: typeof raw === "string" ? { content: raw } : raw,
    };
  } catch (error) {
    return {
      ok: false,
      tool,
      args,
      error: {
        code: "EXECUTION_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
