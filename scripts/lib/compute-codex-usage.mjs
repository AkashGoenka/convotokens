/**
 * Shared core for reading Codex session rollouts: locate session files, read
 * their cumulative token_count snapshots, and fold in delegated subagent
 * rollouts. Used by codex-usage.mjs (single session) and project-usage.mjs
 * (every session under a cwd).
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const sessionsRoot = join(homedir(), ".codex", "sessions");

export function sessionFiles() {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  walk(sessionsRoot);
  return files;
}

export function readSessionMeta(file) {
  try {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
    const rec = JSON.parse(firstLine);
    return rec.type === "session_meta" ? rec.payload : null;
  } catch {
    return null;
  }
}

export function isSubagentMeta(meta) {
  return Boolean(meta?.source?.subagent || meta?.thread_source === "subagent");
}

// A "turn" is one token_count snapshot update — Codex emits one per model
// round-trip, the same cadence used to pick the authoritative `latest` usage
// snapshot below, so counting them is free and consistent with that logic.
export function readSession(file) {
  let meta;
  let latest;
  let malformedLines = 0;
  let turnCount = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "session_meta") meta = rec.payload;
      if (rec.type === "event_msg" && rec.payload?.type === "token_count" && rec.payload.info?.total_token_usage) {
        latest = rec.payload.info.total_token_usage;
        turnCount++;
      }
    } catch {
      malformedLines++;
    }
  }
  return meta ? { file, meta, usage: latest, malformedLines, turnCount } : null;
}

export function findSubagentFiles(file, parentThreadId) {
  const sessionDir = file.slice(0, file.lastIndexOf("/"));
  const childrenByParent = new Map();
  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
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

export function agentType(file) {
  try {
    const first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
    return first.payload?.source?.subagent?.agent_role
      || first.payload?.agent_type
      || first.payload?.agentType
      || first.payload?.agent_nickname
      || first.agent_type
      || "unknown";
  } catch {
    return "unknown";
  }
}

export function emptyTotals() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, turns: 0 };
}

// `usage` is a raw token_count snapshot (no turns field), so the turn count
// for that snapshot's session is passed in separately.
export function addTotals(target, usage, turns = 0) {
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    target[key] += usage?.[key] || 0;
  }
  target.turns += turns;
}

export function findSession(session, cwd) {
  let files = sessionFiles().sort((a, b) => b.localeCompare(a));
  if (session) files = files.filter((file) => file.includes(session));
  for (const file of files) {
    const meta = readSessionMeta(file);
    if (meta && !isSubagentMeta(meta) && (!session || meta.id === session) && (!cwd || meta.cwd === cwd)) return readSession(file);
  }
  return null;
}

/** Every main (non-subagent) session for a cwd, newest first. */
export function listProjectSessions(cwd) {
  const out = [];
  for (const file of sessionFiles()) {
    const meta = readSessionMeta(file);
    if (meta && !isSubagentMeta(meta) && meta.cwd === cwd) out.push({ file, meta });
  }
  out.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

/** Fold a main session plus its delegated subagent rollouts into one usage summary. */
export function computeSessionUsage(file, sessionId) {
  const result = readSession(file);
  if (!result) return null;
  const u = result.usage || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const normalized = {
    transcriptPath: result.file,
    sessionId,
    cwd: result.meta.cwd,
    input_tokens: u.input_tokens || 0,
    cached_input_tokens: u.cached_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    reasoning_output_tokens: u.reasoning_output_tokens || 0,
    total_tokens: u.total_tokens || 0,
    turns: result.turnCount || 0,
    malformedLines: result.malformedLines,
  };
  const bySource = { main: { ...emptyTotals(), total_tokens: normalized.total_tokens, turns: normalized.turns }, subagent: emptyTotals() };
  const byAgentType = {};
  let subagentFileCount = 0;
  for (const file of findSubagentFiles(result.file, sessionId)) {
    const sub = readSession(file);
    if (!sub?.usage) continue;
    subagentFileCount++;
    addTotals(bySource.subagent, sub.usage, sub.turnCount);
    const type = agentType(file);
    byAgentType[type] ??= emptyTotals();
    addTotals(byAgentType[type], sub.usage, sub.turnCount);
  }
  if (subagentFileCount > 0) {
    addTotals(normalized, bySource.subagent, bySource.subagent.turns);
    for (const key of Object.keys(bySource.subagent)) {
      bySource.main[key] = normalized[key] - bySource.subagent[key];
    }
  }
  normalized.bySource = bySource;
  normalized.byAgentType = byAgentType;
  normalized.subagentFileCount = subagentFileCount;
  return normalized;
}
