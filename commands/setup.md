---
description: Connect boomerang to the status line, so it can see your 5-hour and 7-day usage
allowed-tools: Bash(node:*)
---

Run this command once and show the user its output:

```
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" setup "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"
```

Tell the user what it changed. It sets `statusLine` in `~/.claude/settings.json` to boomerang's launcher. If they had a status line before, it still runs after boomerang's, and they keep seeing its output. boomerang needs the status line because it is the only place where Claude Code shows the rate-limit usage.
