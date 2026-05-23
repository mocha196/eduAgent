import { prisma } from "@/lib/db";
import type { SkillEntry } from "@/lib/agent/skills-loader";

/**
 * Loads all enabled AgentStyles from the database and converts them to SkillEntry shape
 * so they can be merged with file-based skills in chatService.
 */
export async function loadEnabledStyles(): Promise<SkillEntry[]> {
  const styles = await prisma.agentStyle.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
  });
  return styles.map((s) => ({
    name: s.name,
    description: s.description,
    version: "1.0.0",
    body: s.body,
    alwaysInject: s.alwaysInject,
    subFiles: {},
    source: "db",
  }));
}
