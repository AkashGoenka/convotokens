---
description: Show tokens consumed inside the current chat, parsed from your local transcript
allowed-tools: Bash(node:*)
argument-hint: [--open] [--json]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" --session "${CLAUDE_SESSION_ID}" --cwd "$(pwd)" $ARGUMENTS`

Present the numbers above to the user as-is. Do not editorialize, estimate a dollar cost, or round the total — Pro/Max is a subscription, not billed per token, so a dollar figure would be a fabricated estimate. Do not offer to open a browser tab or generate a report unless the user asks — pass `--open` yourself only if the user's own message included it.
