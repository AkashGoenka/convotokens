# convotokens

Claude Code plugin. `/convotokens:get-tokens` prints real token counts for the current
chat, parsed from your own local transcript (`~/.claude/projects/.../<session>.jsonl`).
No network calls, no dollar estimates.

## Status: early, unpublished to a marketplace yet

## Scope: Claude Code and Codex

Claude Code is supported through the plugin command and status line. Codex is
supported through `scripts/codex-usage.mjs`, which reads local Codex rollout
transcripts and their cumulative `token_count` snapshots. Run it from the
current workspace with `node scripts/codex-usage.mjs --cwd "$PWD"`, or pass
`--session <id>` for a specific chat. Use `--json` for machine-readable output.

## Fixed bug: naive per-line summing overcounted by ~1.5-2x

The first version summed `message.usage` on every `type:"assistant"` JSONL
line. That "matched a manual `jq` sum exactly" — which felt like validation
but wasn't: the `jq` check used the identical naive per-line approach, so both
were wrong together. Caught only because the reported total looked too large
for the size of the chat, on both this session and a separate small session
("~800k tokens for a small task").

Root cause, confirmed on a real transcript: Claude Code can split ONE API
response across multiple assistant JSONL lines — one per content block
(thinking / text / tool_use / tool_use / ...) — and every fragment carries an
**identical copy of `message.usage`**, since usage describes the whole API
turn, not a block. Measured: 254 raw assistant lines, only 120 unique
`message.id` values — summing every line overcounts by ~1.5-2x depending on
how fragmented that session's responses were.

Fix: dedupe by `message.id`, keeping the first `usage` seen per id. This
logic lives in one place, `scripts/lib/compute-usage.mjs`, shared by both the
`/convotokens:get-tokens` command and the statusLine script below — the dedupe fix can't
regress in one surface without regressing in the other. Re-validated post-fix
against a `jq` group-by-`message.id` sum on a live (still-growing) transcript
— matched within the drift expected from the file growing between the two
runs. Output now prints "N assistant lines deduped to M unique API turns"
whenever they differ, so this can't silently regress unnoticed again.

## How it finds your transcript

Claude Code substitutes `${CLAUDE_SESSION_ID}` into a command's bash execution
(confirmed via a real production plugin that relies on the same substitution
— not officially documented for slash commands, but real and in production
use). Combined with the deterministic cwd-encoding rule (`/` and `.` → `-`),
the transcript path is derived exactly:

```
~/.claude/projects/<encode(cwd)>/<CLAUDE_SESSION_ID>.jsonl
```

No "most recently modified file" guessing, no ambiguity under concurrent
sessions.

**Caveat found empirically:** the cwd-encoded path is the fast common case but
can go stale — observed firsthand when a live transcript relocated from one
cwd-encoded project dir to another mid-session (a worktree-switching
operation moved it without the shell's own `$(pwd)` ever changing). Since
session ids are UUIDs, `findTranscript()` falls back to searching
`~/.claude/projects/*/<session>.jsonl` when the direct path misses — an
unambiguous fallback, not a "most recent file" guess. Whether ordinary CLI/VS
Code usage (no worktree-switching involved) ever hits this is untested; the
fallback is cheap enough to keep regardless.

## Known limitation: `/clear` is invisible in the transcript

Confirmed empirically: `/clear` does NOT start a new transcript file (same
session file continues — Claude Code's own docs confirm the old conversation
"remains on disk"), but it also leaves **no trace inside the JSONL** — no
`SessionStart`/`clear` record is written to the file, even though a
`SessionStart` hook does fire with `source: "clear"` at that moment.

**Consequence:** `/convotokens:get-tokens` sums the *entire* transcript file, which is
"tokens used across this session," not strictly "tokens since your last
`/clear`." If you've cleared mid-session, the total includes pre-clear turns.

**Fix, if precision matters later:** add a `hooks/hooks.json` `SessionStart`
hook (matcher: `clear`) that stamps `{lineOffset, ts}` to a small state file
keyed by session id; the command reads from that offset forward. Not built —
deferred until it's clear (no pun intended) this precision is worth the extra
hook plumbing.

## Two ways to see your usage

### 1. `/convotokens:get-tokens` — on-demand, in the chat

Prints a plain-text table in the chat. Nothing else happens by default —
earlier versions auto-opened an HTML report in a new browser tab on *every*
call, which was bad UX (a fresh tab per invocation, no reused tab). That's
gone now: run `/convotokens:get-tokens --open` if you explicitly want the HTML report
(bar breakdown, per-model table) written to
`$TMPDIR/convotokens-report.html` and opened in your OS default browser, or
`/convotokens:get-tokens --json` for machine-readable output.

### 2. statusLine — passive, CLI only

Claude Code has a native `statusLine` feature: a persistent line above the
CLI's footer, re-rendered on assistant-message events and on an optional
timer. `scripts/statusline.mjs` reads the JSON payload Claude Code pipes to
it on stdin (`session_id`, `workspace.current_dir`), reuses the same
deduped-by-`message.id` engine, and prints one line back:

```
● 51.0k tok this session (44% cache read)
```

**Confirmed empirically, not just from docs: this does NOT render inside the
VS Code extension's Claude Code panel** — only in a real terminal session.
Tested directly: wired up, reloaded the VS Code window, nothing appeared;
the identical config in a plain terminal rendered correctly. Claude Code
plugins also cannot auto-configure a user's `statusLine` — only
`subagentStatusLine` is a supported plugin-settings key — so this requires a
one-time manual edit to your own `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/convotokens/scripts/statusline.mjs",
    "refreshInterval": 10
  }
}
```

(Use an absolute path — `${CLAUDE_PLUGIN_ROOT}` is a command-execution
variable, not available to statusLine's config.)

## Testing it locally (unpublished, no marketplace listing yet)

```bash
claude --plugin-dir /path/to/convotokens
```

Then `/convotokens:get-tokens` inside that session. `/reload-plugins` picks up edits
without restarting.

To test the marketplace-install flow (e.g. via VS Code's `/plugins` UI),
this repo is itself a self-hosted marketplace — add
`/path/to/convotokens` as a marketplace source and install the `convotokens`
plugin from it.

## Not yet done

- Core dedupe/sum logic re-validated directly against a real, live, multi-turn
  transcript from this repo location (not just the original prototype
  location). `claude plugin validate .` passes clean, and `claude --plugin-dir .`
  resolves `/convotokens:get-tokens` correctly (registered, no "Unknown
  command" error).
- **Not yet done**: a real interactive smoke test (`claude --plugin-dir .`,
  then typing `/convotokens:get-tokens` in the TUI). Headless `claude -p`
  one-shot invocations don't have a persisted transcript file for their own
  ephemeral session at the moment the command's bash line runs, so `-p` can't
  exercise this plugin's core path — do this check in a real interactive
  session before submitting.
- No automated tests.
- Codex support (see Scope above) — not started.
