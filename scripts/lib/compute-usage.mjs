/**
 * Shared core: find a session's transcript and sum its real token usage,
 * deduped by message.id. Used by both the CLI command (usage.mjs) and the
 * statusLine script (statusline.mjs) so the dedup fix lives in exactly one
 * place. See usage.mjs's header comment for why the dedup is necessary.
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

export function findTranscript(cwd, session) {
  const direct = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${session}.jsonl`);
  if (existsSync(direct)) return direct;

  const projectsDir = join(homedir(), ".claude", "projects");
  let entries = [];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return direct;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${session}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return direct;
}

export function emptyTotals() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addUsage(target, usage) {
  target.input_tokens += usage.input_tokens || 0;
  target.output_tokens += usage.output_tokens || 0;
  target.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
}

export function totalOf(t) {
  return t.input_tokens + t.output_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;
}

// Task-tool (subagent) turns don't live inline in the main transcript — they're
// written to sidecar files at <session-dir>/subagents/**/agent-<id>.jsonl (can be
// nested under a workflows/<id>/ layer), each with a matching agent-<id>.meta.json
// carrying {agentType, description}. Without folding these in, subagent spend is
// invisible, not just unattributed.
function findSubagentFiles(transcriptPath) {
  if (!transcriptPath.endsWith(".jsonl")) return [];
  const dir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readAgentType(subagentFile) {
  const metaPath = subagentFile.slice(0, -".jsonl".length) + ".meta.json";
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return meta.agentType || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Streams one transcript file, deduping assistant turns by message.id (see
 * usage.mjs header for why). Also tracks compact_boundary system records —
 * only present in main transcripts, harmless no-ops for subagent files — so
 * callers can report both a lifetime total and a since-last-compact total.
 */
async function readTranscriptFile(path) {
  const messages = new Map(); // message.id -> { usage, model }
  const sinceCompact = new Map();
  let totalLines = 0;
  let malformedLines = 0;
  let rawAssistantLines = 0;
  let compactBoundaryCount = 0;
  let lastCompactMeta = null;

  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalLines++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      compactBoundaryCount++;
      lastCompactMeta = rec.compactMetadata || null;
      sinceCompact.clear();
      continue;
    }

    if (rec.type !== "assistant") continue;
    const usage = rec.message?.usage;
    const id = rec.message?.id;
    if (!usage || typeof usage !== "object" || !id) continue;
    rawAssistantLines++;

    if (!messages.has(id)) {
      const entry = { usage, model: rec.message?.model || "unknown" };
      messages.set(id, entry);
      if (!sinceCompact.has(id)) sinceCompact.set(id, entry);
    }
  }

  return { messages, sinceCompact, totalLines, malformedLines, rawAssistantLines, compactBoundaryCount, lastCompactMeta };
}

function sumMessages(messages) {
  const t = emptyTotals();
  for (const { usage } of messages.values()) addUsage(t, usage);
  return { ...t, total: totalOf(t) };
}

export async function computeUsage(transcriptPath) {
  const main = await readTranscriptFile(transcriptPath);

  const overall = emptyTotals();
  const byModel = new Map();
  const bySource = { main: emptyTotals(), subagent: emptyTotals() };
  const byAgentType = new Map();

  for (const { usage, model } of main.messages.values()) {
    addUsage(overall, usage);
    addUsage(bySource.main, usage);
    if (!byModel.has(model)) byModel.set(model, emptyTotals());
    addUsage(byModel.get(model), usage);
  }

  let totalLines = main.totalLines;
  let malformedLines = main.malformedLines;
  let rawAssistantLines = main.rawAssistantLines;
  let uniqueAssistantMessages = main.messages.size;
  let subagentFileCount = 0;

  for (const file of findSubagentFiles(transcriptPath)) {
    let sub;
    try {
      sub = await readTranscriptFile(file);
    } catch {
      continue;
    }
    subagentFileCount++;
    totalLines += sub.totalLines;
    malformedLines += sub.malformedLines;
    rawAssistantLines += sub.rawAssistantLines;
    uniqueAssistantMessages += sub.messages.size;

    const agentType = readAgentType(file);
    if (!byAgentType.has(agentType)) byAgentType.set(agentType, emptyTotals());

    for (const { usage, model } of sub.messages.values()) {
      addUsage(overall, usage);
      addUsage(bySource.subagent, usage);
      addUsage(byAgentType.get(agentType), usage);
      if (!byModel.has(model)) byModel.set(model, emptyTotals());
      addUsage(byModel.get(model), usage);
    }
  }

  return {
    transcriptPath,
    totalLines,
    rawAssistantLines,
    uniqueAssistantMessages,
    malformedLines,
    overall: { ...overall, total: totalOf(overall) },
    byModel: Object.fromEntries([...byModel.entries()].map(([m, t]) => [m, { ...t, total: totalOf(t) }])),
    bySource: {
      main: { ...bySource.main, total: totalOf(bySource.main) },
      subagent: { ...bySource.subagent, total: totalOf(bySource.subagent) },
    },
    byAgentType: Object.fromEntries([...byAgentType.entries()].map(([a, t]) => [a, { ...t, total: totalOf(t) }])),
    subagentFileCount,
    compact: {
      boundaryCount: main.compactBoundaryCount,
      lastPostTokens: main.lastCompactMeta?.postTokens ?? null,
      sinceLastCompact: main.compactBoundaryCount > 0 ? sumMessages(main.sinceCompact) : null,
    },
  };
}
