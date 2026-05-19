#!/usr/bin/env node
/**
 * install-skill.mjs — Install a skill from GitHub or a local path.
 *
 * Usage:
 *   node scripts/install-skill.mjs <owner/repo> <path/in/repo> [--ref=main] [--force]
 *   node scripts/install-skill.mjs --local <path/to/skill/dir>
 *
 * Examples:
 *   node scripts/install-skill.mjs anthropics/skills skills/pptx
 *   node scripts/install-skill.mjs anthropics/skills skills/pptx --force
 *   node scripts/install-skill.mjs anthropics/skills skills/docx --ref=main
 *   node scripts/install-skill.mjs --local C:/my-skills/my-skill
 *
 * Environment variables:
 *   GITHUB_TOKEN — optional personal access token to avoid rate limiting
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { get as httpsGet } from "https";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { argv, env, exit } from "process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// skills/ is at project root: edu-platform/scripts/../../skills
const SKILLS_DIR = resolve(__dirname, "..", "..", "skills");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchJson(url, token) {
  return new Promise((res, rej) => {
    const headers = { "User-Agent": "install-skill.mjs", Accept: "application/vnd.github.v3+json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    httpsGet(url, { headers }, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        return fetchJson(r.headers.location, token).then(res).catch(rej);
      }
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => {
        try { res(JSON.parse(data)); }
        catch (e) { rej(new Error(`JSON parse failed from ${url}: ${e.message}`)); }
      });
      r.on("error", rej);
    }).on("error", rej);
  });
}

function fetchText(url, token) {
  return new Promise((res, rej) => {
    const headers = { "User-Agent": "install-skill.mjs" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    httpsGet(url, { headers }, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        return fetchText(r.headers.location, token).then(res).catch(rej);
      }
      if (r.statusCode !== 200) {
        return rej(new Error(`HTTP ${r.statusCode} from ${url}`));
      }
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => res(data));
      r.on("error", rej);
    }).on("error", rej);
  });
}

// ---------------------------------------------------------------------------
// Install from GitHub
// ---------------------------------------------------------------------------

async function installFromGitHub(repo, repoPath, ref, force) {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error('Invalid repo format — expected "owner/repo".');
    exit(1);
  }
  const [owner, repoName] = parts;
  const token = env.GITHUB_TOKEN ?? null;

  // Derive local skill name from the last segment of the repo path
  const skillName = repoPath.replace(/\/$/, "").split("/").pop();
  if (!skillName) { console.error("Cannot derive skill name from repo path."); exit(1); }

  const destDir = join(SKILLS_DIR, skillName);
  if (existsSync(destDir) && !force) {
    console.error(`Skill "${skillName}" already exists at ${destDir}`);
    console.error("Run with --force to overwrite.");
    exit(1);
  }

  console.log(`Fetching  https://github.com/${owner}/${repoName}/tree/${ref}/${repoPath}`);

  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${repoPath}?ref=${ref}`;
  const items = await fetchJson(apiUrl, token);

  if (!Array.isArray(items)) {
    const msg = items?.message ?? JSON.stringify(items);
    console.error(`GitHub API error: ${msg}`);
    if (!token && msg.includes("rate limit")) {
      console.error("Tip: set GITHUB_TOKEN env variable to raise the rate limit.");
    }
    exit(1);
  }

  if (force && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });

  for (const item of items) {
    if (item.type === "file" && item.download_url) {
      process.stdout.write(`  Downloading ${item.name} ... `);
      const content = await fetchText(item.download_url, token);
      writeFileSync(join(destDir, item.name), content, "utf-8");
      console.log("done");
    } else if (item.type === "dir") {
      console.log(`  Skipping subdirectory "${item.name}/" (not downloaded)`);
    }
  }

  console.log(`\nInstalled "${skillName}" → ${destDir}`);
  console.log("Restart the app (or invalidate the SkillsLoader singleton) to use it.");
}

// ---------------------------------------------------------------------------
// Install from local path
// ---------------------------------------------------------------------------

function installLocal(srcPath, force) {
  const resolved = resolve(srcPath);
  if (!existsSync(resolved)) {
    console.error(`Local path not found: ${resolved}`);
    exit(1);
  }
  const skillName = basename(resolved);
  const destDir = join(SKILLS_DIR, skillName);
  if (existsSync(destDir) && !force) {
    console.error(`Skill "${skillName}" already exists at ${destDir}`);
    console.error("Run with --force to overwrite.");
    exit(1);
  }
  if (force && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(SKILLS_DIR, { recursive: true });
  cpSync(resolved, destDir, { recursive: true });
  console.log(`Installed "${skillName}" → ${destDir}`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function usage() {
  console.error(`
Usage:
  node scripts/install-skill.mjs <owner/repo> <path/in/repo> [--ref=<branch>] [--force]
  node scripts/install-skill.mjs --local <path/to/skill/dir> [--force]

Options:
  --ref=<branch>   Git ref to fetch from (default: main)
  --force          Overwrite if skill already exists
  --local <path>   Copy from a local directory instead of GitHub

Environment:
  GITHUB_TOKEN     Optional GitHub personal access token (avoids rate limiting)

Examples:
  node scripts/install-skill.mjs anthropics/skills skills/pptx
  node scripts/install-skill.mjs anthropics/skills skills/pptx --force
  node scripts/install-skill.mjs --local ../my-custom-skill
`);
  exit(1);
}

const rawArgs = argv.slice(2);
const force = rawArgs.includes("--force");
const refArg = rawArgs.find((a) => a.startsWith("--ref="));
const ref = refArg ? refArg.slice(6) : "main";
const localIdx = rawArgs.indexOf("--local");

if (localIdx !== -1) {
  const localPath = rawArgs[localIdx + 1];
  if (!localPath || localPath.startsWith("--")) usage();
  installLocal(localPath, force);
} else {
  const positional = rawArgs.filter((a) => !a.startsWith("--"));
  if (positional.length < 2) usage();
  const [repo, repoPath] = positional;
  installFromGitHub(repo, repoPath, ref, force).catch((e) => {
    console.error("Error:", e.message);
    exit(1);
  });
}
