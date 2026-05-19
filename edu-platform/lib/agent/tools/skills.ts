/**
 * Skills tools: list_skills, view_skill
 * Reads from all configured skill sources via the SkillsLoader singleton.
 */

import type { Tool } from "../types";
import { getSkillsLoader } from "../skills-loader";

export const listSkillsTool: Tool = {
  name: "list_skills",
  description: "列出当前所有可用的教学技能（name + description 索引）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<string> {
    const skills = getSkillsLoader().load();
    if (skills.length === 0) return "（暂无已注册技能）";
    const lines = skills.map((s) => {
      const subList = Object.keys(s.subFiles);
      const subNote = subList.length > 0 ? ` [sub-docs: ${subList.join(", ")}]` : "";
      return `- **${s.name}** v${s.version} (${s.source}): ${s.description || "（无描述）"}${subNote}`;
    });
    return lines.join("\n");
  },
};

export const viewSkillTool: Tool = {
  name: "view_skill",
  description:
    "查看某个技能的完整内容。不传 file 时返回主 SKILL.md；" +
    "传入 file（如 pptxgenjs.md）时返回对应子文档内容。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能名称（来自 list_skills）" },
      file: {
        type: "string",
        description:
          "子文档文件名（可选，如 pptxgenjs.md、editing.md），不填则返回主 SKILL.md",
      },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return JSON.stringify({ error: "缺少必要参数：name" });
    const loader = getSkillsLoader();

    if (typeof args.file === "string" && args.file.trim()) {
      const fileName = args.file.trim();
      const content = loader.getSubFile(name, fileName);
      if (content === null)
        return JSON.stringify({ error: `技能 "${name}" 中不存在子文档 "${fileName}"` });
      return content.slice(0, 8000);
    }

    const body = loader.getBody(name);
    if (body === null) return JSON.stringify({ error: `技能 "${name}" 不存在` });
    return body.slice(0, 8000);
  },
};
