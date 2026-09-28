---
description: Show or change which agents run on the cheap OpenCode model (list, sync, pin <agent> claude|opencode|auto)
allowed-tools: Bash(node:*)
argument-hint: "[list | sync | pin <agent> <claude|opencode|auto>]"
---

Run this command and show the user its output as it is:

```
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" external $ARGUMENTS --data "${CLAUDE_PLUGIN_DATA}"
```

With no arguments it lists every agent with its runtime (claude or opencode), the reason, and the model. `sync` applies the rule now instead of at the next session start. `pin <agent> claude|opencode|auto` sets one agent by hand (`auto` goes back to the rule). The rule itself is set in `/config` ("Which agents use the cheap model" and "Cheap model"), and in `~/.claude/boomerang/config.json` (`cheap_model_can_edit_files`). Changes to agents take effect in the next Claude Code session.
