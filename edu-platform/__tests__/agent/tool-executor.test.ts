import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@/lib/agent/tool-registry";
import { executeToolCall } from "@/lib/agent/tool-executor";

const ctx = {
  userId: "u-1",
  sessionId: "s-1",
  accessibleCourseIds: [],
};

function buildRegistry(execute = vi.fn(async () => "ok")) {
  const registry = new ToolRegistry();
  registry.register({
    name: "calculate",
    description: "计算",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["count"],
    },
    execute,
  });
  return { registry, execute };
}

describe("executeToolCall", () => {
  it("拒绝格式错误的 JSON，且不执行工具", async () => {
    const { registry, execute } = buildRegistry();
    const result = await executeToolCall({
      registry,
      toolName: "calculate",
      rawArguments: "{bad json",
      ctx,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_JSON");
    expect(execute).not.toHaveBeenCalled();
  });

  it("统一校验必填字段、类型、范围和额外字段", async () => {
    const invalidInputs = [
      "{}",
      JSON.stringify({ count: "2" }),
      JSON.stringify({ count: 0 }),
      JSON.stringify({ count: 2, hidden: true }),
    ];

    for (const rawArguments of invalidInputs) {
      const { registry, execute } = buildRegistry();
      const result = await executeToolCall({
        registry,
        toolName: "calculate",
        rawArguments,
        ctx,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENTS");
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("校验通过后执行工具并统一普通字符串结果", async () => {
    const { registry, execute } = buildRegistry();
    const result = await executeToolCall({
      registry,
      toolName: "calculate",
      rawArguments: JSON.stringify({ count: 3 }),
      ctx,
      allowedToolNames: new Set(["calculate"]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual({ content: "ok" });
    expect(execute).toHaveBeenCalledWith({ count: 3 }, ctx);
  });

  it("执行端再次强制检查工具白名单", async () => {
    const { registry, execute } = buildRegistry();
    const result = await executeToolCall({
      registry,
      toolName: "calculate",
      rawArguments: JSON.stringify({ count: 3 }),
      ctx,
      allowedToolNames: new Set(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_NOT_ALLOWED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("审批钩子拒绝后不执行工具", async () => {
    const { registry, execute } = buildRegistry();
    const result = await executeToolCall({
      registry,
      toolName: "calculate",
      rawArguments: JSON.stringify({ count: 3 }),
      ctx,
      beforeExecute: async () => ({ allowed: false, message: "denied" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXECUTION_REJECTED");
    expect(execute).not.toHaveBeenCalled();
  });
});
