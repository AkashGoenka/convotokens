# convotokens

Claude Code plugin. `/convotokens` prints real token counts for the current
chat, parsed from your own local transcript (`~/.claude/projects/.../<session>.jsonl`).
No network calls, no dollar estimates.

## Status: early, unpublished to a marketplace yet

## Scope: Claude Code today, Codex is a future direction

v1 targets Claude Code only. Codex is a real candidate for later — the name
was chosen to be provider-neutral for exactly that reason — but it's a
materially bigger lift than it looks: different transcript format, different
on-disk location, and Codex doesn't have Claude Code-style slash-command
plugins at all (its equivalent extension surface is repo-scoped skills). Not
started; do not assume Codex works.

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

Fix: dedupe by `message.id`, keep one `usage` per id, union the
coldstart-tool-use check across every fragment of that id (the tool_use block
and the fragment whose usage gets kept aren't necessarily the same line). This
logic lives in one place, `scripts/lib/compute-usage.mjs`, shared by both the
`/convotokens` command and the statusLine script below — the dedupe fix can't
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

**Consequence:** `/convotokens` sums the *entire* transcript file, which is
"tokens used across this session," not strictly "tokens since your last
`/clear`." If you've cleared mid-session, the total includes pre-clear turns.

**Fix, if precision matters later:** add a `hooks/hooks.json` `SessionStart`
hook (matcher: `clear`) that stamps `{lineOffset, ts}` to a small state file
keyed by session id; the command reads from that offset forward. Not built —
deferred until it's clear (no pun intended) this precision is worth the extra
hook plumbing.

## Attribution caveat (coldstart share)

If you use [coldstart](https://github.com/AkashGoenka/coldstart)'s MCP tools
in a session, `/convotokens` calls out coldstart's share of the total —
its tool identity is a clean prefix match (`mcp__coldstart__find`,
`mcp__coldstart__gs`, no separate server-identity field needed). The
remaining approximation: an assistant turn's *entire* usage is attributed to
coldstart if that turn contains any `mcp__coldstart__*` tool call, even if
the same turn also called other tools or wrote substantial unrelated text.
This is turn-level, not call-level, apportionment — disclosed here, not
hidden. It's a nice-to-have side feature, not the point of this plugin.

## Two ways to see your usage

### 1. `/convotokens` — on-demand, in the chat

Prints a plain-text table in the chat. Nothing else happens by default —
earlier versions auto-opened an HTML report in a new browser tab on *every*
call, which was bad UX (a fresh tab per invocation, no reused tab). That's
gone now: run `/convotokens --open` if you explicitly want the HTML report
(bar breakdown, per-model table, coldstart share) written to
`$TMPDIR/convotokens-report.html` and opened in your OS default browser, or
`/convotokens --json` for machine-readable output.

### 2. statusLine — passive, CLI only

Claude Code has a native `statusLine` feature: a persistent line above the
CLI's footer, re-rendered on assistant-message events and on an optional
timer. `scripts/statusline.mjs` reads the JSON payload Claude Code pipes to
it on stdin (`session_id`, `workspace.current_dir`), reuses the same
deduped-by-`message.id` engine, and prints one line back:

```
● 51.0k tok this session (44% cache read)  coldstart 12%
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

Then `/convotokens` inside that session. `/reload-plugins` picks up edits
without restarting.

To test the marketplace-install flow (e.g. via VS Code's `/plugins` UI),
this repo is itself a self-hosted marketplace — add
`/path/to/convotokens` as a marketplace source and install the `convotokens`
plugin from it.

## Not yet done

- Not yet run end-to-end via `--plugin-dir` in a fresh clone of this repo
  (only validated inside the original prototype location before migration).
- No automated tests.
- Codex support (see Scope above) — not started.
