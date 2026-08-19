import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillEntry } from "@/lib/agent/skills-loader";
import type { TurnContext } from "@/lib/agent/types";

const { mockLoader, mockAgentStyle } = vi.hoisted(() => ({
  mockLoader: {
    load: vi.fn<() => SkillEntry[]>(),
    getBody: vi.fn<(name: string) => string | null>(),
    getSubFile: vi.fn<(skillName: string, fileName: string) => string | null>(),
  },
  mockAgentStyle: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/agent/skills-loader", () => ({
  getSkillsLoader: () => mockLoader,
}));

vi.mock("@/lib/db", () => ({
  prisma: { agentStyle: mockAgentStyle },
}));

import { listSkillsTool, viewSkillTool } from "@/lib/agent/tools/skills";

const ctx: TurnContext = { userId: "", sessionId: "", accessibleCourseIds: [] };

const stubSkill: SkillEntry = {
  name: "Socratic",
  description: "启发式提问技能",
  version: "2.1.0",
  body: "你应该先提问，再解释。\n\n## 使用方法\n按照苏格拉底式方法引导思考。",
  alwaysInject: false,
  subFiles: {},
  source: "built-in",
};

describe("skills tools", () => {
  beforeEach(() => {
    mockLoader.load.mockReset();
    mockLoader.getBody.mockReset();
    mockLoader.getSubFile.mockReset();
    mockAgentStyle.findMany.mockReset().mockResolvedValue([]);
    mockAgentStyle.findUnique.mockReset().mockResolvedValue(null);
  });

  // ---- list_skills ----------------------------------------------------------

  it("业务规则：list_skills 在无技能注册时应返回友好提示", async () => {
    // given
    mockLoader.load.mockReturnValue([]);

    // when
    const result = await listSkillsTool.execute({}, ctx);

    // then
    expect(result).toContain("暂无已注册技能");
  });

  it("业务规则：list_skills 应列出技能名称、版本、来源和描述", async () => {
    // given
    mockLoader.load.mockReturnValue([stubSkill]);

    // when
    const result = await listSkillsTool.execute({}, ctx);

    // then
    expect(result).toContain("Socratic");
    expect(result).toContain("v2.1.0");
    expect(result).toContain("built-in");
    expect(result).toContain("启发式提问技能");
  });

  it("业务规则：list_skills 应在有子文档时显示 sub-docs 标注", async () => {
    // given
    const skillWithSubs: SkillEntry = {
      ...stubSkill,
      name: "Planner",
      subFiles: { "steps.md": "步骤内容", "template.md": "模板内容" },
    };
    mockLoader.load.mockReturnValue([skillWithSubs]);

    // when
    const result = await listSkillsTool.execute({}, ctx);

    // then
    expect(result).toContain("sub-docs");
    expect(result).toContain("steps.md");
    expect(result).toContain("template.md");
  });

  // ---- view_skill -----------------------------------------------------------

  it("业务规则：view_skill 缺少 name 时应返回错误 JSON", async () => {
    // given

    // when
    const result = await viewSkillTool.execute({ name: "" }, ctx);

    // then
    const parsed = JSON.parse(result as string) as { error: string };
    expect(parsed.error).toContain("缺少必要参数：name");
  });

  it("业务规则：view_skill 对不存在的技能应返回错误 JSON", async () => {
    // given
    mockLoader.getBody.mockReturnValue(null);

    // when
    const result = await viewSkillTool.execute({ name: "nonexistent" }, ctx);

    // then
    const parsed = JSON.parse(result as string) as { error: string };
    expect(parsed.error).toContain("nonexistent");
    expect(parsed.error).toContain("不存在");
  });

  it("业务规则：view_skill 应返回技能主体内容", async () => {
    // given
    mockLoader.getBody.mockReturnValue(stubSkill.body);

    // when
    const result = await viewSkillTool.execute({ name: "Socratic" }, ctx);

    // then
    expect(result).toContain("先提问");
    expect(result).toContain("苏格拉底");
  });

  it("业务规则：view_skill 传入 file 参数时应返回对应子文档内容", async () => {
    // given
    mockLoader.getSubFile.mockReturnValue("## 执行步骤\n1. 分析\n2. 执行");

    // when
    const result = await viewSkillTool.execute({ name: "Planner", file: "steps.md" }, ctx);

    // then
    expect(result).toContain("执行步骤");
    expect(result).toContain("分析");
    // 应按实际请求 getSubFile
    expect(mockLoader.getSubFile).toHaveBeenCalledWith("Planner", "steps.md");
  });

  it("业务规则：view_skill 请求不存在的子文档时应返回错误 JSON", async () => {
    // given
    mockLoader.getSubFile.mockReturnValue(null);

    // when
    const result = await viewSkillTool.execute({ name: "Planner", file: "missing.md" }, ctx);

    // then
    const parsed = JSON.parse(result as string) as { error: string };
    expect(parsed.error).toContain("missing.md");
    expect(parsed.error).toContain("不存在");
  });
});
