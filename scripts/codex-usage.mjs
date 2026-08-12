#!/usr/bin/env node
/**
 * Reports token usage for a Codex session.
 * Codex writes cumulative token_count snapshots, so only the latest snapshot
 * in the session transcript is authoritative; summing snapshots overcounts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sessionsRoot = join(homedir(), ".codex", "sessions");

function parseArgs(argv) {
  const out = { session: "", cwd: process.cwd(), cwdProvided: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.session = argv[++i] || "";
    else if (argv[i] === "--cwd") {
      out.cwd = argv[++i] || out.cwd;
      out.cwdProvided = true;
    }
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

function sessionFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  walk(sessionsRoot);
  return files;
}

function readSession(file) {
  let meta;
  let latest;
  let malformedLines = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "session_meta") meta = rec.payload;
      // Codex writes cumulative snapshots. Repeated snapshots are expected,
      // not duplicated API turns; only the final snapshot is authoritative.
      if (rec.type === "event_msg" && rec.payload?.type === "token_count" && rec.payload.info?.total_token_usage) {
        latest = rec.payload.info.total_token_usage;
      }
    } catch { malformedLines++; }
  }
  return meta ? { file, meta, usage: latest, malformedLines } : null;
}

function isSubagentMeta(meta) {
  return Boolean(meta?.source?.subagent || meta?.thread_source === "subagent");
}

function findSubagentFiles(file, parentThreadId) {
  const sessionDir = file.slice(0, file.lastIndexOf("/"));
  const childrenByParent = new Map();
  let entries;
  try { entries = readdirSync(sessionDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const candidate = join(sessionDir, entry.name);
    if (candidate === file) continue;
    const meta = readSessionMeta(candidate);
    const parent = meta?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (isSubagentMeta(meta) && parent) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(candidate);
    }
  }
  const out = [];
  const queue = [parentThreadId];
  const seen = new Set();
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      const childMeta = readSessionMeta(child);
      if (childMeta?.id) queue.push(childMeta.id);
    }
  }
  return out;
}

function agentType(file) {
  try {
    const first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
    return first.payload?.source?.subagent?.agent_role
      || first.payload?.agent_type
      || first.payload?.agentType
      || first.payload?.agent_nickname
      || first.agent_type
      || "unknown";
  } catch { return "unknown"; }
}

function addTotals(target, usage) {
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    target[key] += usage?.[key] || 0;
  }
}

function emptyTotals() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
}

function readSessionMeta(file) {
  try {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
    const rec = JSON.parse(firstLine);
    return rec.type === "session_meta" ? rec.payload : null;
  } catch {
    return null;
  }
}

function findSession(session, cwd) {
  let files = sessionFiles().sort((a, b) => b.localeCompare(a));
  if (session) files = files.filter((file) => file.includes(session));
  for (const file of files) {
    const meta = readSessionMeta(file);
    if (meta && !isSubagentMeta(meta) && (!session || meta.id === session) && (!cwd || meta.cwd === cwd)) return readSession(file);
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  // A supplied session id is globally unique, so do not accidentally reject
  // it just because the command was run from a different workspace.
  const cwd = args.session && !args.cwdProvided ? "" : args.cwd;
  try { result = findSession(args.session, cwd); } catch (err) {
    console.error(`convotokens: ${err.message}`); process.exit(1);
  }
  if (!result) { console.error("No Codex session transcript found for this cwd."); process.exit(1); }
  const u = result.usage || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const normalized = {
    transcriptPath: result.file,
    sessionId: result.meta.id,
    cwd: result.meta.cwd,
    input_tokens: u.input_tokens || 0,
    cached_input_tokens: u.cached_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    reasoning_output_tokens: u.reasoning_output_tokens || 0,
    total_tokens: u.total_tokens || 0,
    malformedLines: result.malformedLines,
  };
  const bySource = { main: { ...emptyTotals(), total_tokens: normalized.total_tokens }, subagent: emptyTotals() };
  const byAgentType = {};
  let subagentFileCount = 0;
  for (const file of findSubagentFiles(result.file, result.meta.id)) {
    const sub = readSession(file);
    if (!sub?.usage) continue;
    subagentFileCount++;
    addTotals(bySource.subagent, sub.usage);
    const type = agentType(file);
    byAgentType[type] ??= emptyTotals();
    addTotals(byAgentType[type], sub.usage);
  }
  if (subagentFileCount > 0) {
    addTotals(normalized, bySource.subagent);
    for (const key of Object.keys(bySource.subagent)) {
      bySource.main[key] = normalized[key] - bySource.subagent[key];
    }
  }
  normalized.bySource = bySource;
  normalized.byAgentType = byAgentType;
  normalized.subagentFileCount = subagentFileCount;
  if (args.json) return console.log(JSON.stringify(normalized, null, 2));
  console.log(`Transcript: ${normalized.transcriptPath}`);
  console.log("Total token usage this session:");
  console.log(`  Input:      ${normalized.input_tokens.toLocaleString("en-US")}`);
  console.log(`  Cached:     ${normalized.cached_input_tokens.toLocaleString("en-US")}`);
  console.log(`  Output:     ${normalized.output_tokens.toLocaleString("en-US")}`);
  console.log(`  Reasoning:  ${normalized.reasoning_output_tokens.toLocaleString("en-US")}`);
  console.log(`  TOTAL:      ${normalized.total_tokens.toLocaleString("en-US")}`);
  if (normalized.subagentFileCount > 0) {
    console.log(`\nSubagent usage — ${normalized.subagentFileCount} transcript(s), folded into the total above:`);
    console.log(`  Main:      ${normalized.bySource.main.total_tokens.toLocaleString("en-US")}`);
    console.log(`  Subagents: ${normalized.bySource.subagent.total_tokens.toLocaleString("en-US")}`);
    for (const [type, usage] of Object.entries(normalized.byAgentType)) {
      console.log(`    ${type}: ${usage.total_tokens.toLocaleString("en-US")}`);
    }
  }
}

main();
