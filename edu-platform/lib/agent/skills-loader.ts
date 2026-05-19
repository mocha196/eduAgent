/**
 * SkillsLoader — reads skills/*.md (and skills/{name}/SKILL.md) files.
 * Supports multiple source directories via skills.config.json.
 */

import * as fs from "fs";
import * as path from "path";

export type SkillSource = {
  /** Resolved absolute path to a skills directory. */
  path: string;
  /** Human-readable label shown in skill listings. */
  label: string;
  /** If false, this source is skipped entirely during load. */
  enabled: boolean;
};

export type SkillEntry = {
  name: string;
  description: string;
  version: string;
  body: string;
  alwaysInject: boolean;
  /** Companion .md files in the same skill directory (filename → content). */
  subFiles: Record<string, string>;
  /** Source label this skill was loaded from. */
  source: string;
};

type Frontmatter = {
  name?: string;
  description?: string;
  version?: string;
  always_inject?: boolean;
};

function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const yamlBlock = match[1];
  const body = match[2].trimStart();

  // Minimal YAML key: value parser (no arrays/objects needed for frontmatter)
  const meta: Frontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    const trimmed = val.trim();
    if (key === "name") meta.name = trimmed;
    else if (key === "description") meta.description = trimmed;
    else if (key === "version") meta.version = trimmed;
    else if (key === "always_inject") meta.always_inject = trimmed === "true";
  }
  return { meta, body };
}

export class SkillsLoader {
  private sources: SkillSource[];

  constructor(sources: SkillSource[]) {
    this.sources = sources;
  }

  load(): SkillEntry[] {
    const entries: SkillEntry[] = [];
    const seen = new Set<string>();

    for (const source of this.sources) {
      if (!source.enabled || !fs.existsSync(source.path)) continue;

      // Directory-based skills (name/SKILL.md) take priority within each source
      for (const entry of fs.readdirSync(source.path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(source.path, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        const raw = fs.readFileSync(skillMd, "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name ?? entry.name;
        if (seen.has(name)) continue; // earlier source wins
        seen.add(name);

        // Scan companion .md files (sub-documents referenced from SKILL.md)
        const subFiles: Record<string, string> = {};
        for (const sub of fs.readdirSync(path.join(source.path, entry.name), { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith(".md") && sub.name !== "SKILL.md") {
            subFiles[sub.name] = fs.readFileSync(
              path.join(source.path, entry.name, sub.name),
              "utf-8",
            );
          }
        }

        entries.push({
          name,
          description: meta.description ?? "",
          version: meta.version ?? "1.0.0",
          body,
          alwaysInject: meta.always_inject ?? false,
          subFiles,
          source: source.label,
        });
      }

      // Flat skills/*.md files
      for (const entry of fs.readdirSync(source.path, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const stem = entry.name.replace(/\.md$/, "");
        const raw = fs.readFileSync(path.join(source.path, entry.name), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name ?? stem;
        if (seen.has(name)) continue;
        seen.add(name);
        entries.push({
          name,
          description: meta.description ?? "",
          version: meta.version ?? "1.0.0",
          body,
          alwaysInject: meta.always_inject ?? false,
          subFiles: {},
          source: source.label,
        });
      }
    }

    return entries;
  }

  getBody(name: string): string | null {
    return this.load().find((s) => s.name === name)?.body ?? null;
  }

  /**
   * Returns the content of a companion sub-document (e.g. "pptxgenjs.md")
   * inside a directory-based skill. Returns null if not found.
   */
  getSubFile(skillName: string, fileName: string): string | null {
    return this.load().find((s) => s.name === skillName)?.subFiles[fileName] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — reads skills.config.json (process.cwd()) if present
// ---------------------------------------------------------------------------

function readConfig(): SkillSource[] {
  const configPath = path.join(process.cwd(), "skills.config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        sources?: Array<{ path: string; label?: string; enabled?: boolean }>;
      };
      if (Array.isArray(parsed.sources)) {
        return parsed.sources.map((s) => ({
          path: path.resolve(process.cwd(), s.path),
          label: s.label ?? "custom",
          enabled: s.enabled !== false,
        }));
      }
    } catch {
      // fall through to default
    }
  }
  return [{ path: path.resolve(process.cwd(), "../skills"), label: "built-in", enabled: true }];
}

let _singleton: SkillsLoader | null = null;

/** Returns the process-wide SkillsLoader singleton (initialised from skills.config.json). */
export function getSkillsLoader(): SkillsLoader {
  if (_singleton) return _singleton;
  _singleton = new SkillsLoader(readConfig());
  return _singleton;
}

/** Invalidates the singleton so the next getSkillsLoader() call re-reads skills.config.json. */
export function resetSkillsLoader(): void {
  _singleton = null;
}
