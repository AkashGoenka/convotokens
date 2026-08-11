#!/usr/bin/env node
/**
 * Reports token usage for a Codex session.
 * Codex writes cumulative token_count snapshots, so only the latest snapshot
 * in the session transcript is authoritative; summing snapshots overcounts.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
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
      if (rec.type === "event_msg" && rec.payload?.type === "token_count" && rec.payload.info?.total_token_usage) {
        latest = rec.payload.info.total_token_usage;
      }
    } catch { malformedLines++; }
  }
  return meta ? { file, meta, usage: latest, malformedLines } : null;
}

function readSessionMeta(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0];
    const rec = JSON.parse(firstLine);
    return rec.type === "session_meta" ? rec.payload : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function findSession(session, cwd) {
  let files = sessionFiles().sort((a, b) => b.localeCompare(a));
  if (session) files = files.filter((file) => file.includes(session));
  for (const file of files) {
    const meta = readSessionMeta(file);
    if (meta && (!session || meta.id === session) && (!cwd || meta.cwd === cwd)) return readSession(file);
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
  if (args.json) return console.log(JSON.stringify(normalized, null, 2));
  console.log(`Transcript: ${normalized.transcriptPath}`);
  console.log("Total token usage this session:");
  console.log(`  Input:      ${normalized.input_tokens.toLocaleString("en-US")}`);
  console.log(`  Cached:     ${normalized.cached_input_tokens.toLocaleString("en-US")}`);
  console.log(`  Output:     ${normalized.output_tokens.toLocaleString("en-US")}`);
  console.log(`  Reasoning:  ${normalized.reasoning_output_tokens.toLocaleString("en-US")}`);
  console.log(`  TOTAL:      ${normalized.total_tokens.toLocaleString("en-US")}`);
}

main();
