/**
 * Shared core: find a session's transcript and sum its real token usage,
 * deduped by message.id. Used by both the CLI command (usage.mjs) and the
 * statusLine script (statusline.mjs) so the dedup fix lives in exactly one
 * place. See usage.mjs's header comment for why the dedup is necessary.
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
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

export const MCP_COLDSTART_PREFIX = "mcp__coldstart__";

export async function computeUsage(transcriptPath) {
  const messages = new Map(); // message.id -> { usage, model, usedColdstart }
  let malformedLines = 0;
  let totalLines = 0;
  let rawAssistantLines = 0;

  const rl = createInterface({ input: createReadStream(transcriptPath, "utf8"), crlfDelay: Infinity });

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

    if (rec.type !== "assistant") continue;
    const usage = rec.message?.usage;
    const id = rec.message?.id;
    if (!usage || typeof usage !== "object" || !id) continue;
    rawAssistantLines++;

    const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
    const usedColdstart = content.some(
      (b) => b && b.type === "tool_use" && typeof b.name === "string" && b.name.startsWith(MCP_COLDSTART_PREFIX),
    );

    const existing = messages.get(id);
    if (!existing) {
      messages.set(id, { usage, model: rec.message?.model || "unknown", usedColdstart });
    } else if (usedColdstart) {
      existing.usedColdstart = true;
    }
  }

  const overall = emptyTotals();
  const coldstart = emptyTotals();
  const byModel = new Map();

  for (const { usage, model, usedColdstart } of messages.values()) {
    addUsage(overall, usage);
    if (!byModel.has(model)) byModel.set(model, emptyTotals());
    addUsage(byModel.get(model), usage);
    if (usedColdstart) addUsage(coldstart, usage);
  }

  return {
    transcriptPath,
    totalLines,
    rawAssistantLines,
    uniqueAssistantMessages: messages.size,
    malformedLines,
    overall: { ...overall, total: totalOf(overall) },
    byModel: Object.fromEntries([...byModel.entries()].map(([m, t]) => [m, { ...t, total: totalOf(t) }])),
    coldstart: { ...coldstart, total: totalOf(coldstart) },
  };
}
