#!/usr/bin/env node
/**
 * Claude Code statusLine script. Claude Code invokes this on assistant-message
 * events (and on a refreshInterval timer, if configured) and pipes a JSON
 * payload on stdin containing session_id, workspace.current_dir, etc. — field
 * names confirmed empirically against a live session, not just docs. We use
 * those two fields to locate the same transcript usage.mjs reads, and print a
 * single line back to stdout — that line becomes the status line.
 *
 * CLI-only: confirmed empirically that Claude Code's VS Code extension does
 * not render statusLine at all, so this has no effect there.
 */
import { findTranscript, computeUsage } from "./lib/compute-usage.mjs";

const ESC = "";
const CYAN = `${ESC}[36m`;
const MAGENTA = `${ESC}[35m`;
const RESET = `${ESC}[0m`;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("convotokens: could not parse statusLine stdin");
    return;
  }

  const sessionId = payload.session_id;
  const cwd = payload.workspace?.current_dir || payload.cwd;
  if (!sessionId || !cwd) {
    process.stdout.write(`convotokens: missing session_id/cwd in payload (keys: ${Object.keys(payload).join(", ")})`);
    return;
  }

  const transcriptPath = findTranscript(cwd, sessionId);
  const result = await computeUsage(transcriptPath).catch(() => null);
  if (!result || result.uniqueAssistantMessages === 0) {
    process.stdout.write("convotokens: 0 tokens (no assistant turns yet)");
    return;
  }

  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const t = result.overall;
  const cacheReadPct = Math.round((t.cache_read_input_tokens / t.total) * 100);
  let line = `${CYAN}●${RESET} ${fmt(t.total)} tok this session (${cacheReadPct}% cache read)`;

  if (result.coldstart.total > 0) {
    const pct = ((result.coldstart.total / t.total) * 100).toFixed(0);
    line += `  ${MAGENTA}coldstart ${pct}%${RESET}`;
  }

  process.stdout.write(line);
}

main().catch((err) => {
  process.stdout.write(`convotokens: error (${err?.message || err})`);
});
