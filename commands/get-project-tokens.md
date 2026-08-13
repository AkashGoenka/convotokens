---
description: Show total token usage across every local session for this project
allowed-tools: Bash(node:*)
argument-hint: [--engine claude|codex|both] [--json]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/project-usage.mjs" --cwd "$(pwd)" $ARGUMENTS`

Present the numbers above to the user as-is. Do not editorialize, estimate a dollar cost, or round the total — Pro/Max is a subscription, not billed per token, so a dollar figure would be a fabricated estimate. This is the sum across every local session tied to this project directory, not just the current chat.
