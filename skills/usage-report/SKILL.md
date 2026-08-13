---
name: usage-report
description: Report token usage from local Claude Code or Codex transcripts. Use when the user asks for token counts, usage totals, turn counts, model/source breakdowns, subagent usage, project-wide totals, or usage since compaction/clear.
---

# Convotokens

Use the bundled local scripts to report transcript-derived token usage. These
scripts read local files only; they do not make network calls or estimate
dollar costs.

## Codex

For Codex usage, run from the repository root:

```bash
node scripts/codex-usage.mjs --cwd "$PWD"
```

Use `--session <id>` when the user identifies a specific session, and append
`--json` when structured output is useful.

The Codex script uses the latest cumulative `token_count` snapshot in each
rollout, and counts a turn as one `token_count` update. It discovers
delegated subagent rollouts through their `parent_thread_id`, includes nested
descendants, excludes child rollouts from newest-session selection, and
reports main versus subagent totals and turns.

## Claude Code

For Claude usage, run:

```bash
node scripts/usage.mjs --session "$CLAUDE_SESSION_ID" --cwd "$PWD"
```

Pass `--json` for structured output or `--open` only when the user explicitly
asks for the local HTML report. A turn is one unique `message.id` after
dedup; the report includes a turn count overall and per source (main vs.
subagent) and per agent type.

## Project-wide totals

To sum usage across every local session tied to this project directory (not
just the current chat), for either engine:

```bash
node scripts/project-usage.mjs --cwd "$PWD"
```

Pass `--engine claude` or `--engine codex` to scope to one engine, and
`--json` for structured output.

## Response rules

Present the reported numbers as-is. Do not invent dollar estimates or round
totals. Briefly explain whether the result is lifetime session usage, a
single-session total vs. a project-wide total, since the latest compaction,
or a main/subagent total when that distinction appears in the output.
