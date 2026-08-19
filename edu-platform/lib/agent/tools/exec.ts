/**
 * exec_skill_script — Anthropic skills mechanism adapter.
 *
 * Proxies execution of scripts inside a skill's scripts/ directory to the
 * Python rag-service (/run-skill-script). This mirrors the execution model
 * used by Anthropic's Claude Code, where skills bundle both instructions and
 * executable scripts that the agent can run.
 *
 * Security:
 *  - Only registered skills (via SkillsLoader) are allowed.
 *  - Path traversal is enforced server-side in rag-service.
 *  - Only .py / .js extensions (or -m module) are accepted.
 *  - Input files come from presigned URLs only, never local paths.
 *  - requiresApproval: false — skill scripts are trusted by design.
 *    Set AgentConfig.approvalMode = "auto" to also skip all other approvals.
 */

import type { Tool, TurnContext } from "../types";
import { getSkillsLoader } from "../skills-loader";
import { getMinioPresignedUrl } from "@/lib/minio";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "tool:exec" });
const PRESIGN_TTL_SEC = 900; // 15 minutes

type RunSkillScriptResponse = {
  stdout: string;
  stderr: string;
  return_code: number;
  output_key?: string | null;
};

export const execSkillScriptTool: Tool = {
  name: "exec_skill_script",
  description:
    "执行某个 skill 的 scripts/ 目录下的脚本文件，或通过 -m 运行 Python 模块。" +
    "适用于读取/分析 .pptx、编辑幻灯片、生成缩略图等需要调用脚本的操作。" +
    "执行前用 view_skill 读取 SKILL.md 获取具体脚本用法。",
  parameters: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        minLength: 1,
        description: "技能名称，如 pptx（必须与 list_skills 返回的名称一致）",
      },
      script: {
        type: "string",
        minLength: 1,
        description:
          "脚本路径（相对于该 skill 的 scripts/ 目录），如 thumbnail.py、office/unpack.py；" +
          "或 Python 模块调用形式，如 -m markitdown",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "传给脚本的 CLI 参数列表。" +
          "用 {input_file} 引用已下载的临时输入文件路径；" +
          "用 {output_file} 引用期望的输出文件路径。",
      },
      input_file_url: {
        type: "string",
        description:
          "可选。输入文件的预签名 URL（MinIO 或其他可访问 URL）。" +
          "下载后保存到临时目录，通过 {input_file} 在 args 中引用。",
      },
      input_filename: {
        type: "string",
        description:
          "可选。input_file_url 对应的原始文件名（如 presentation.pptx），" +
          "用于确定临时文件扩展名。不填则使用 input。",
      },
      output_filename: {
        type: "string",
        description:
          "可选。脚本执行后期望生成的文件名（在脚本工作目录中）。" +
          "若该文件存在，将上传到 MinIO 并返回预签名下载 URL（15 分钟有效）。",
      },
      timeout_sec: {
        type: "number",
        minimum: 1,
        maximum: 300,
        description: "执行超时秒数，默认 60，最大 300。",
      },
    },
    required: ["skill", "script"],
  },
  requiresApproval: false,
  category: "write",

  async execute(args: Record<string, unknown>, ctx: TurnContext): Promise<string> {
    const t0 = Date.now();
    const skill = typeof args.skill === "string" ? args.skill.trim() : "";
    const script = typeof args.script === "string" ? args.script.trim() : "";

    if (!skill) return JSON.stringify({ error: "缺少必要参数：skill" });
    if (!script) return JSON.stringify({ error: "缺少必要参数：script" });

    // Verify skill exists and has scripts/ directory
    const loader = getSkillsLoader();
    const scriptsDir = loader.getScriptDir(skill);
    if (scriptsDir === null) {
      // Check if skill exists at all
      const body = loader.getBody(skill);
      if (body === null) return JSON.stringify({ error: `技能 "${skill}" 不存在，请先用 list_skills 确认名称` });
      return JSON.stringify({ error: `技能 "${skill}" 没有 scripts/ 目录，无法执行脚本` });
    }

    const ragServiceUrl = (process.env.RAG_SERVICE_URL ?? "http://localhost:8001").replace(/\/$/, "");
    const ragServiceKey = process.env.RAG_SERVICE_API_KEY ?? "";

    const payload = {
      skill,
      script,
      args: Array.isArray(args.args) ? args.args : [],
      input_file_url: typeof args.input_file_url === "string" ? args.input_file_url : null,
      input_filename: typeof args.input_filename === "string" ? args.input_filename : null,
      output_filename: typeof args.output_filename === "string" ? args.output_filename : null,
      user_id: ctx.userId,
      timeout_sec: typeof args.timeout_sec === "number" ? Math.min(args.timeout_sec, 300) : 60,
    };
    log.debug({ skill, script, timeoutSec: payload.timeout_sec }, "exec_skill_script start");

    let resp: Response;
    try {
      resp = await fetch(`${ragServiceUrl}/run-skill-script`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": ragServiceKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
          (payload.timeout_sec + 30) * 1000, // extra 30s for network + upload
        ),
      });
    } catch (err) {
      return JSON.stringify({
        error: `rag-service 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return JSON.stringify({ error: `rag-service 返回 ${resp.status}: ${text.slice(0, 500)}` });
    }

    const result = (await resp.json()) as RunSkillScriptResponse;

    // Generate presigned URL for output file (rag-service only returns the MinIO key)
    let output_url: string | undefined;
    if (result.output_key) {
      try {
        output_url = await getMinioPresignedUrl(result.output_key, PRESIGN_TTL_SEC);
      } catch (err) {
        log.warn({ err, outputKey: result.output_key }, "exec_skill_script presign failed");
      }
    }

    log.debug({ skill, script, returnCode: result.return_code, hasOutput: !!output_url, durationMs: Date.now() - t0 }, "exec_skill_script done");
    return JSON.stringify({
      return_code: result.return_code,
      stdout: result.stdout,
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(output_url ? { output_url, output_expires_in: "15 minutes" } : {}),
    });
  },
};
