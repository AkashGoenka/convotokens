#!/usr/bin/env node
/**
 * Reports token usage for a Codex session.
 * Codex writes cumulative token_count snapshots, so only the latest snapshot
 * in the session transcript is authoritative; summing snapshots overcounts.
 */
import { findSession, computeSessionUsage } from "./lib/compute-codex-usage.mjs";

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

  const normalized = computeSessionUsage(result.file, result.meta.id);
  if (args.json) return console.log(JSON.stringify(normalized, null, 2));
  console.log(`Transcript: ${normalized.transcriptPath}`);
  console.log("Total token usage this session:");
  console.log(`  Input:      ${normalized.input_tokens.toLocaleString("en-US")}`);
  console.log(`  Cached:     ${normalized.cached_input_tokens.toLocaleString("en-US")}`);
  console.log(`  Output:     ${normalized.output_tokens.toLocaleString("en-US")}`);
  console.log(`  Reasoning:  ${normalized.reasoning_output_tokens.toLocaleString("en-US")}`);
  console.log(`  TOTAL:      ${normalized.total_tokens.toLocaleString("en-US")}`);
  console.log(`  Turns:      ${normalized.turns.toLocaleString("en-US")}`);
  if (normalized.subagentFileCount > 0) {
    console.log(`\nSubagent usage — ${normalized.subagentFileCount} transcript(s), folded into the total above:`);
    console.log(`  Main:      ${normalized.bySource.main.total_tokens.toLocaleString("en-US")} tokens, ${normalized.bySource.main.turns.toLocaleString("en-US")} turns`);
    console.log(`  Subagents: ${normalized.bySource.subagent.total_tokens.toLocaleString("en-US")} tokens, ${normalized.bySource.subagent.turns.toLocaleString("en-US")} turns`);
    for (const [type, usage] of Object.entries(normalized.byAgentType)) {
      console.log(`    ${type}: ${usage.total_tokens.toLocaleString("en-US")} tokens, ${usage.turns.toLocaleString("en-US")} turns`);
    }
  }
}

main();
