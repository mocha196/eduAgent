/**
 * read_attachment — fetch the full text content of a non-image attachment by ID.
 *
 * The attachment content is injected into the user message automatically for small
 * files (<= 8 KB). For larger files, or when the agent needs the raw bytes for further
 * processing, it calls this tool to retrieve up to 32 KB of text content.
 */

import type { Tool, TurnContext } from "../types";

const READ_ATTACHMENT_MAX_CHARS = 32_000;

function resolveUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Replace common private/container host names with the public-facing URL configured
    // in the environment, mirroring the same fallback used by the vision pre-processor.
    const privateHosts = ["minio", "localhost", "127.0.0.1", "host.docker.internal"];
    if (privateHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
      const publicOrigin = process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "";
      if (publicOrigin) {
        u.hostname = new URL(publicOrigin.startsWith("http") ? publicOrigin : `https://${publicOrigin}`).hostname;
        u.port = "";
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export const readAttachmentTool: Tool = {
  name: "read_attachment",
  description:
    "读取用户上传的文本类附件（代码文件、文档等）的完整内容，返回纯文本。" +
    "当附件内容被截断或需要完整代码/文档时使用。仅适用于文本类文件，不适用于图片。",
  parameters: {
    type: "object",
    properties: {
      attachment_id: {
        type: "string",
        description: "附件 ID，来自附件列表中的 id 字段。",
      },
    },
    required: ["attachment_id"],
  },
  requiresApproval: false,
  category: "read",

  async execute(args: Record<string, unknown>, ctx?: TurnContext): Promise<string> {
    const attachmentId = typeof args.attachment_id === "string" ? args.attachment_id.trim() : "";
    if (!attachmentId) {
      return JSON.stringify({ error: "attachment_id 不能为空" });
    }

    const attachment = ctx?.attachments?.find((a) => a.id === attachmentId);
    if (!attachment) {
      return JSON.stringify({ error: `未找到 ID 为 '${attachmentId}' 的附件。请检查附件列表中的 id 字段。` });
    }

    if (attachment.mime_type.startsWith("image/")) {
      return JSON.stringify({ error: "图片附件不支持文本读取，请使用 analyzeImage 工具。" });
    }

    const url = resolveUrl(attachment.presigned_url);
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        return JSON.stringify({ error: `获取附件失败，HTTP ${resp.status}` });
      }
      let content = await resp.text();
      let truncated = false;
      if (content.length > READ_ATTACHMENT_MAX_CHARS) {
        content = content.slice(0, READ_ATTACHMENT_MAX_CHARS);
        truncated = true;
      }
      return JSON.stringify({
        name: attachment.name,
        mime_type: attachment.mime_type,
        content,
        truncated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `读取附件时出错：${msg}` });
    }
  },
};
