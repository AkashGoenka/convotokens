# convotokens

`convotokens` reports the tokens consumed inside your local Claude Code and Codex sessions, parsed from your own transcripts. It makes no network calls and does not invent dollar estimates.

## Install in Codex from GitHub

The repository is packaged as a Codex skills-only plugin and includes a
marketplace manifest. Add the GitHub repository as a Codex marketplace, then
install the plugin:

```bash
codex plugin marketplace add https://github.com/AkashGoenka/convotokens.git
codex plugin add convotokens@convotokens
```

To inspect the configured marketplace or refresh its Git snapshot:

```bash
codex plugin marketplace list
codex plugin marketplace upgrade convotokens
```

The plugin manifest is [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and the Codex workflow is [`skills/usage-report/SKILL.md`](skills/usage-report/SKILL.md). The plugin is skills-only because it reads local transcript files and does not need an MCP server.

## Use with Codex

From the repository root, the underlying command is:

```bash
node scripts/codex-usage.mjs --cwd "$PWD"
```

Useful options:

```bash
# Read one specific session
node scripts/codex-usage.mjs --session <session-id>

# Emit machine-readable output
node scripts/codex-usage.mjs --cwd "$PWD" --json
```

Codex writes cumulative `token_count` snapshots, so the latest snapshot in each rollout is authoritative. The command does not sum snapshots, because that would overcount usage. It does count them, though: a turn is one `token_count` update, the same cadence Codex uses to publish each usage snapshot.

Delegated Codex work is stored in separate sibling rollout files. The command follows `parent_thread_id` links, includes nested descendants, excludes child rollouts from normal session selection, and reports total usage, turns, main versus subagent usage, usage by agent type, and the number of subagent rollouts included.

Codex `/clear` starts a new session transcript. A lookup by workspace selects the newest parent session, while `--session` lets you inspect an older session explicitly.

## Use with Claude Code

Claude Code has the corresponding marketplace flow:

Inside a Claude Code session, run:

```text
/plugin marketplace add AkashGoenka/convotokens
/plugin install convotokens@convotokens
```

The equivalent CLI commands are:

```bash
claude plugin marketplace add https://github.com/AkashGoenka/convotokens.git
claude plugin install convotokens@convotokens
```

For local development without installing from a marketplace, load the checkout
directly:
```bash
claude --plugin-dir /path/to/convotokens
```

Then run this command inside Claude Code:

```text
/convotokens:get-tokens
```

Optional arguments are `/convotokens:get-tokens --json` and `/convotokens:get-tokens --open`.

The Claude command streams the local session transcript, deduplicates fragmented assistant records by `message.id`, and reports model, turn, main-agent, subagent, and compaction-aware totals. A turn is one unique `message.id` after dedup. Claude subagent transcripts are read from their nested sidecar files.

## Total tokens for a project

Both engines can also report usage summed across every local session tied to a project directory, not just the current chat:

```bash
node scripts/project-usage.mjs --cwd "$PWD"
```

Pass `--engine claude` or `--engine codex` to scope to one engine, and `--json` for structured output. This sums each session's already-folded (main + subagent) total, so multi-session spend on a project is visible without re-reading every transcript by hand.

Inside a Claude Code session, the equivalent command is:

```text
/convotokens:get-project-tokens
```

## Claude status line

Claude Code can display a compact passive status line. Add this to `~/.claude/settings.json`, using an absolute path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/convotokens/scripts/statusline.mjs",
    "refreshInterval": 10
  }
}
```

## Install for development

```bash
git clone https://github.com/AkashGoenka/convotokens.git
cd convotokens
node --test test/*.test.mjs
node --check scripts/codex-usage.mjs
node --check scripts/project-usage.mjs
git diff --check
```

For Claude development, use `claude --plugin-dir .`; `/reload-plugins` picks up plugin edits in an active session.

## Repository layout

```text
.codex-plugin/plugin.json               Codex plugin manifest
skills/usage-report/SKILL.md            Codex skill instructions
commands/get-tokens.md                  Claude slash command — this session
commands/get-project-tokens.md          Claude slash command — this project
scripts/codex-usage.mjs                 Codex transcript reader (one session)
scripts/usage.mjs                       Claude usage report (one session)
scripts/project-usage.mjs               Total usage across a project (both engines)
scripts/statusline.mjs                  Claude status-line integration
scripts/lib/compute-usage.mjs           Shared Claude accounting engine
scripts/lib/compute-codex-usage.mjs     Shared Codex accounting engine
scripts/lib/compute-project-usage.mjs   Project-wide summing over resolved sessions
test/                                    Automated fixtures and tests
```

## Privacy and accounting

All usage data is read from local transcript files. The tool does not upload transcripts or call an external service. Token totals are usage counts, not billed-dollar amounts.

Claude and Codex require different accounting strategies:

- Claude assistant records can repeat the same API-turn usage across multiple content-block lines, so Claude is deduplicated by `message.id`; each unique `message.id` is one turn.
- Codex records cumulative snapshots, so Codex uses only the latest snapshot from each rollout and folds linked subagent rollouts into the parent total; each `token_count` snapshot update is one turn.

Both engines fold subagent (delegated) usage into the session it was spawned from, and report a turn count alongside every token total — for the whole session, and broken out by source (main vs. subagent) and by agent type when more than one subagent ran.

## Status

The repository is available for GitHub-based installation and local testing. Public directory publication remains subject to the platform’s plugin review and account requirements.

## License

MIT. See [`LICENSE`](LICENSE).
