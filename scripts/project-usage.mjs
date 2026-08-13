#!/usr/bin/env node
/**
 * Sums token usage across every local session tied to a project (cwd), not
 * just the current one. Claude Code groups a project's transcripts under one
 * directory (see encodeCwd); Codex tags each rollout's session_meta with its
 * cwd. Both engines already fold subagent spend into a single session's
 * total (compute-usage.mjs / compute-codex-usage.mjs) — this script sums
 * those per-session totals across every session in the project.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "./lib/compute-usage.mjs";
import { listProjectSessions } from "./lib/compute-codex-usage.mjs";
import { sumClaudeSessions, sumCodexSessions } from "./lib/compute-project-usage.mjs";

function parseArgs(argv) {
  const out = { cwd: process.cwd(), engine: "both", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") out.cwd = argv[++i] || out.cwd;
    else if (argv[i] === "--engine") out.engine = argv[++i] || out.engine;
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

function claudeProjectSessions(cwd) {
  const dir = join(homedir(), ".claude", "projects", encodeCwd(cwd));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(dir, e.name));
}

async function claudeProjectUsage(cwd) {
  const { sessionCount, overall } = await sumClaudeSessions(claudeProjectSessions(cwd));
  return { engine: "claude", sessionCount, overall };
}

function codexProjectUsage(cwd) {
  const { sessionCount, overall } = sumCodexSessions(listProjectSessions(cwd));
  return { engine: "codex", sessionCount, overall };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wantClaude = args.engine === "both" || args.engine === "claude";
  const wantCodex = args.engine === "both" || args.engine === "codex";

  const result = { cwd: args.cwd };
  if (wantClaude) result.claude = await claudeProjectUsage(args.cwd);
  if (wantCodex) result.codex = codexProjectUsage(args.cwd);
  if (wantClaude && wantCodex) {
    result.combinedTotal = result.claude.overall.total + result.codex.overall.total_tokens;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fmt = (n) => n.toLocaleString("en-US");
  console.log(`Project: ${args.cwd}`);
  console.log("Tokens consumed inside this project, summed across every local session (main + subagents already folded in per session):\n");

  if (result.claude) {
    const c = result.claude;
    console.log(`Claude Code — ${c.sessionCount} session(s):`);
    console.log(`  Total:  ${fmt(c.overall.total)}`);
    console.log(`  Turns:  ${fmt(c.overall.turns)}`);
  }
  if (result.codex) {
    const cx = result.codex;
    console.log(`${result.claude ? "\n" : ""}Codex — ${cx.sessionCount} session(s):`);
    console.log(`  Total:  ${fmt(cx.overall.total_tokens)}`);
    console.log(`  Turns:  ${fmt(cx.overall.turns)}`);
  }
  if (result.combinedTotal != null) {
    console.log(`\nCombined total (Claude + Codex): ${fmt(result.combinedTotal)}`);
  }
}

main().catch((err) => {
  console.error(`convotokens: ${err?.message || err}`);
  process.exit(1);
});
