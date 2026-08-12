# convotokens

`convotokens` reports real token usage from local Claude Code and Codex transcripts. It makes no network calls and does not invent dollar estimates.

## Install in Codex from GitHub

The repository is packaged as a Codex skills-only plugin. To install it from GitHub:

1. Open Codex and open the Plugins view.
2. Choose the option to add or install a plugin from a marketplace/repository.
3. Enter `https://github.com/AkashGoenka/convotokens`.
4. Install `convotokens` from the repository marketplace.

The plugin manifest is [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and the Codex workflow is [`skills/convotokens/SKILL.md`](skills/convotokens/SKILL.md). The plugin is skills-only because it reads local transcript files and does not need an MCP server.

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

Codex writes cumulative `token_count` snapshots, so the latest snapshot in each rollout is authoritative. The command does not sum snapshots, because that would overcount usage.

Delegated Codex work is stored in separate sibling rollout files. The command follows `parent_thread_id` links, includes nested descendants, excludes child rollouts from normal session selection, and reports total usage, main versus subagent usage, usage by agent type, and the number of subagent rollouts included.

Codex `/clear` starts a new session transcript. A lookup by workspace selects the newest parent session, while `--session` lets you inspect an older session explicitly.

## Use with Claude Code

Install or load the repository as a Claude Code plugin:

```bash
claude --plugin-dir /path/to/convotokens
```

Then run this command inside Claude Code:

```text
/convotokens:get-tokens
```

Optional arguments are `/convotokens:get-tokens --json` and `/convotokens:get-tokens --open`.

The Claude command streams the local session transcript, deduplicates fragmented assistant records by `message.id`, and reports model, main-agent, subagent, and compaction-aware totals. Claude subagent transcripts are read from their nested sidecar files.

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
git diff --check
```

For Claude development, use `claude --plugin-dir .`; `/reload-plugins` picks up plugin edits in an active session.

## Repository layout

```text
.codex-plugin/plugin.json       Codex plugin manifest
skills/convotokens/SKILL.md     Codex skill instructions
commands/get-tokens.md          Claude slash command
scripts/codex-usage.mjs         Codex transcript reader
scripts/lib/compute-usage.mjs   Shared Claude accounting engine
scripts/usage.mjs               Claude usage report
scripts/statusline.mjs          Claude status-line integration
test/                            Automated fixtures and tests
```

## Privacy and accounting

All usage data is read from local transcript files. The tool does not upload transcripts or call an external service. Token totals are usage counts, not billed-dollar amounts.

Claude and Codex require different accounting strategies:

- Claude assistant records can repeat the same API-turn usage across multiple content-block lines, so Claude is deduplicated by `message.id`.
- Codex records cumulative snapshots, so Codex uses only the latest snapshot from each rollout and folds linked subagent rollouts into the parent total.

## Status

The repository is available for GitHub-based installation and local testing. Public directory publication remains subject to the platform’s plugin review and account requirements.

## License

MIT. See [`LICENSE`](LICENSE).
