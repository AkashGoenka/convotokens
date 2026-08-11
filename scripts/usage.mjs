#!/usr/bin/env node
/**
 * Sums real token usage for the current Claude Code session from its local
 * JSONL transcript. Stream-parses line by line (transcripts can be multi-MB).
 *
 * Transcript path is derived, not guessed: Claude Code names each session's
 * file <session-uuid>.jsonl inside a project dir named by encoding the cwd
 * (each "/" and "." replaced with "-"). Given an exact session id (passed by
 * the caller, e.g. via ${CLAUDE_SESSION_ID} in a command's bash execution)
 * this is normally a deterministic lookup, not a "most recently modified
 * file" guess — see findTranscript() for the one case where it isn't.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { findTranscript, computeUsage } from "./lib/compute-usage.mjs";

function parseArgs(argv) {
  const out = { session: "", json: false, open: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.session = argv[++i] || "";
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--open") out.open = true;
    else if (argv[i] === "--cwd") out.cwd = argv[++i] || out.cwd;
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Best-effort open in the OS default browser. Never throws. */
function openInBrowser(file) {
  const cmd =
    process.platform === "darwin" ? { bin: "open", args: [file] }
    : process.platform === "win32" ? { bin: "cmd", args: ["/c", "start", "", file] }
    : { bin: "xdg-open", args: [file] };
  try {
    const child = execFile(cmd.bin, cmd.args, { windowsHide: true }, () => {});
    child.unref();
  } catch { /* ignore — the path is printed regardless */ }
}

const CATEGORY_COLORS = {
  "Cache read": "#4c86f9",
  "Cache creation": "#8c6ef2",
  Output: "#2fb583",
  Input: "#f2a93c",
};

function renderHtml(result) {
  const fmt = (n) => n.toLocaleString("en-US");
  const total = result.overall.total || 1;
  const categories = [
    ["Cache read", result.overall.cache_read_input_tokens],
    ["Cache creation", result.overall.cache_creation_input_tokens],
    ["Output", result.overall.output_tokens],
    ["Input", result.overall.input_tokens],
  ];

  const barSegments = categories
    .map(([label, n]) => `<div class="seg" style="width:${((n / total) * 100).toFixed(2)}%;background:${CATEGORY_COLORS[label]}" title="${label}: ${fmt(n)}"></div>`)
    .join("");

  const legendRows = categories
    .map(([label, n]) => `
      <tr>
        <td><span class="dot" style="background:${CATEGORY_COLORS[label]}"></span>${label}</td>
        <td class="num">${fmt(n)}</td>
        <td class="num muted">${((n / total) * 100).toFixed(1)}%</td>
      </tr>`)
    .join("");

  const modelEntries = Object.entries(result.byModel);
  const modelRows = modelEntries.length > 1
    ? `<table class="model-table"><thead><tr><th>Model</th><th>Tokens</th></tr></thead><tbody>${
        modelEntries.map(([m, t]) => `<tr><td>${escapeHtml(m)}</td><td class="num">${fmt(t.total)}</td></tr>`).join("")
      }</tbody></table>`
    : "";

  const warning = result.malformedLines > 0
    ? `<div class="warning">${result.malformedLines} malformed line(s) skipped out of ${result.totalLines}.</div>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Token Consumption — this chat</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --card: #f7f7f8; --border: #e5e7eb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16171a; --fg: #f0f0f2; --muted: #9aa0a6; --card: #1f2023; --border: #2c2d31; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.5rem; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; justify-content: center;
  }
  .card { width: 100%; max-width: 560px; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.25rem; }
  .path { font-size: 0.75rem; color: var(--muted); word-break: break-all; margin-bottom: 1.75rem; font-family: ui-monospace, monospace; }
  .total { font-size: 2.4rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
  .total-label { color: var(--muted); font-size: 0.85rem; margin-bottom: 1.25rem; }
  .bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: var(--border); margin-bottom: 1.25rem; }
  .seg { height: 100%; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 0.4rem 0; text-align: left; font-size: 0.88rem; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.5rem; }
  .model-table { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  .warning { margin-top: 1rem; font-size: 0.8rem; color: #b45309; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: var(--muted); }
</style>
</head>
<body>
  <div class="card">
    <h1>Token consumption — this chat</h1>
    <div class="path">${escapeHtml(result.transcriptPath)}</div>
    <div class="total">${fmt(result.overall.total)}</div>
    <div class="total-label">total tokens, not billed dollars — Pro/Max is subscription, not per-token</div>
    <div class="bar">${barSegments}</div>
    <table>${legendRows}</table>
    ${modelRows}
    ${warning}
    <footer>Generated locally from your own transcript. No network calls.${
      result.rawAssistantLines !== result.uniqueAssistantMessages
        ? ` ${fmt(result.rawAssistantLines)} assistant lines deduped to ${fmt(result.uniqueAssistantMessages)} unique API turns.`
        : ""
    }</footer>
  </div>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) {
    console.error("usage: usage.mjs --session <session-uuid> [--cwd <dir>] [--json]");
    process.exit(1);
  }

  const transcriptPath = findTranscript(args.cwd, args.session);
  if (!existsSync(transcriptPath)) {
    console.error(`No transcript found at ${transcriptPath}`);
    process.exit(1);
  }

  // Claude Code can split ONE API response across MULTIPLE assistant JSONL
  // lines — one per content block (thinking / text / tool_use / ...) — each
  // carrying an IDENTICAL copy of message.usage (usage describes the whole
  // API turn, not a block) but only a fragment of message.content. Summing
  // every line overcounts by however many fragments each turn produced —
  // confirmed on a real transcript: 224 assistant lines, 106 unique message
  // ids, naive sum 1.6x too high. computeUsage() dedupes by message.id.
  const result = await computeUsage(transcriptPath);
  const { byModel } = result;

  if (args.open) {
    const outPath = join(tmpdir(), "convotokens-report.html");
    writeFileSync(outPath, renderHtml(result));
    openInBrowser(outPath);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fmt = (n) => n.toLocaleString("en-US");
  console.log(`Transcript: ${transcriptPath}`);
  if (result.malformedLines > 0) {
    console.log(`Warning: ${result.malformedLines} malformed line(s) skipped out of ${result.totalLines}.`);
  }
  if (result.rawAssistantLines !== result.uniqueAssistantMessages) {
    console.log(
      `(${fmt(result.rawAssistantLines)} assistant lines deduped to ${fmt(result.uniqueAssistantMessages)} unique API turns — Claude Code splits one response across multiple lines, each repeating the same usage)`,
    );
  }
  console.log("");
  console.log("Total token usage this session (not billed dollars — Pro/Max is subscription, not per-token):");
  console.log(`  Input:           ${fmt(result.overall.input_tokens)}`);
  console.log(`  Output:          ${fmt(result.overall.output_tokens)}`);
  console.log(`  Cache read:      ${fmt(result.overall.cache_read_input_tokens)}`);
  console.log(`  Cache creation:  ${fmt(result.overall.cache_creation_input_tokens)}`);
  console.log(`  TOTAL:           ${fmt(result.overall.total)}`);

  const modelEntries = Object.entries(byModel);
  if (modelEntries.length > 1) {
    console.log("\nPer-model breakdown:");
    for (const [model, t] of modelEntries) {
      console.log(`  ${model}: ${fmt(t.total)} tokens`);
    }
  }

}

main().catch((err) => {
  console.error(`convotokens: ${err?.message || err}`);
  process.exit(1);
});
