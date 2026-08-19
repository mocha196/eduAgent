/**
 * run_script — arbitrary code execution tool with mandatory user approval.
 *
 * The agent can write any Python or JavaScript snippet and ask to run it.
 * Because the code is arbitrary (not a pre-vetted skill script), the tool
 * is gated behind `requiresApproval: true` so the ReAct loop always pauses
 * and emits a `require_approval` SSE event before touching the server.
 *
 * Execution is proxied to rag-service /run-arbitrary-script, which:
 *  - writes the code to a temp file inside an isolated tmpdir
 *  - runs it via subprocess (python / node)
 *  - caps stdout/stderr and enforces a hard timeout
 *  - cleans up the tmpdir afterwards
 */

import type { Tool } from "../types";

type RunScriptResponse = {
  stdout: string;
  stderr: string;
  return_code: number;
};

export const runScriptTool: Tool = {
  name: "run_script",
  description:
    "在服务器上运行一段任意的 Python 或 JavaScript 代码，返回 stdout / stderr 和退出码。" +
    "适用于数值计算、数据处理、算法演示等场景。" +
    "执行前必须经过用户审批。不要在此工具中运行网络请求或写入持久化文件。",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["python", "javascript"],
        description: "脚本语言：python 或 javascript",
      },
      code: {
        type: "string",
        minLength: 1,
        maxLength: 8000,
        description: "要执行的脚本源码，最长 8000 字符。",
      },
      timeout_sec: {
        type: "number",
        minimum: 5,
        maximum: 60,
        description: "执行超时秒数，默认 30，最大 60。",
      },
    },
    required: ["language", "code"],
  },
  requiresApproval: true,
  approvalReason: "Agent 将在服务器上运行以下代码，请确认是否允许执行。",
  category: "dangerous",

  async execute(args: Record<string, unknown>): Promise<string> {
    const language = typeof args.language === "string" ? args.language.trim() : "";
    const code = typeof args.code === "string" ? args.code : "";

    if (language !== "python" && language !== "javascript") {
      return JSON.stringify({ error: "language 必须为 'python' 或 'javascript'" });
    }
    if (!code.trim()) {
      return JSON.stringify({ error: "缺少必要参数：code" });
    }
    if (code.length > 8000) {
      return JSON.stringify({ error: "code 超过 8000 字符限制" });
    }

    const timeout_sec =
      typeof args.timeout_sec === "number" ? Math.min(Math.max(args.timeout_sec, 5), 60) : 30;

    const ragUrl = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/$/, "");
    const ragKey = process.env.RAG_SERVICE_API_KEY ?? "";

    let resp: Response;
    try {
      resp = await fetch(`${ragUrl}/run-arbitrary-script`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ragKey ? { "X-Internal-Key": ragKey } : {}),
        },
        body: JSON.stringify({ language, code, timeout_sec }),
        signal: AbortSignal.timeout((timeout_sec + 30) * 1000),
      });
    } catch (err) {
      return JSON.stringify({
        error: `rag-service 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return JSON.stringify({ error: `rag-service 返回 ${resp.status}: ${text.slice(0, 400)}` });
    }

    const result = (await resp.json()) as RunScriptResponse;
    return JSON.stringify({
      return_code: result.return_code,
      stdout: result.stdout,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    });
  },
};
