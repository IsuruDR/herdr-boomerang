# herdr-boomerang

A Claude Code plugin for [Herdr](https://herdr.dev). When Claude gets close to its 5-hour or 7-day usage limit, boomerang makes Claude write a handoff while it still has budget, and gives the work to Codex in a Herdr pane. When Codex finishes and Claude's limit window resets, the work comes back to Claude.

```
 Claude works ──> usage reaches 85% (5-hour) or 95% (7-day)
      │
      v
 Claude finishes the current step and writes a handoff
      │
      v
 Herdr opens a pane "boomerang-codex" beside Claude
   [Enter] start Codex   [a] start, and always auto-start   [q] cancel
      │
      v
 Codex reads the handoff, works, and writes a report
      │
      v
 Claude's limit window resets ──> Claude reads the report and continues
```

If the limit arrives before Claude can write the handoff, boomerang builds one from Claude's transcript and `git status`, and Codex starts anyway.

## What you need

- A Claude Code subscription that shows usage limits. The docs name Pro and Max; we also saw them on a Team seat. With an API key there are no limits to read, so boomerang does nothing.
- Node.js 22.18 or later. boomerang runs its TypeScript files directly and has no runtime dependencies.
- [Herdr](https://herdr.dev), with Claude Code running inside a Herdr pane. Outside Herdr, boomerang only saves the handoff and tells you the command to run.
- The [Codex CLI](https://github.com/openai/codex).

## Install

```
/plugin marketplace add IsuruDR/herdr-boomerang
/plugin install boomerang@boomerang
/boomerang:setup
```

`/boomerang:setup` is needed one time. A plugin cannot set the Claude Code status line, and the status line is the only place where Claude Code shows the usage limits. Setup points `statusLine` in `~/.claude/settings.json` at boomerang's launcher. If you had a status line before, it still runs after boomerang's, and you keep seeing its output. Without an old status line, you see `5h 42% | 7d 61% | ctx 23%`.

## Settings

Change them in `/config`, under boomerang.

| Setting | Default | What it does |
|---|---|---|
| Switch mode | `confirm` | `confirm`: open Codex and wait for you. `auto`: start Codex at once. `notify`: only save the handoff and tell you. |
| 5-hour limit threshold (%) | 85 | Start the handoff at this 5-hour usage. |
| 7-day limit threshold (%) | 95 | Start the handoff at this 7-day usage. |
| Codex placement | `split` | `split`: a pane beside Claude. `tab`: a new tab in the same workspace. |
| Extra Codex arguments | empty | Added when Codex starts. Without a sandbox choice here, boomerang uses `--sandbox workspace-write`, because Codex must write files to continue the work. |
| Hand back to Claude | on | When Codex finishes and Claude's limit has reset, tell Claude to read the report and continue. |

`[a]` on the confirm screen asks once more (`[y/N]`) before it sets Switch mode to `auto`, so a stray key never changes a setting. You can set it back in `/config`.

## Cheap-model agents

Claude Code picks a subagent by its description. boomerang can run some of your subagents on a low-cost model in [OpenCode](https://opencode.ai) instead of on Claude, and the result still comes back to Claude as a normal subagent result.

```
 Claude main agent ── picks "codebase-scout" by its description (as always)
        │
        v
 proxy "codebase-scout" (Haiku, Bash only, small context)
        │  boomerang delegate codebase-scout
        v
 OpenCode runs the real codebase-scout on the cheap model,
 in the Herdr pane "boomerang-codebase-scout" (or headless outside Herdr)
        │
        v
 its answer ──> the proxy's result ──> Claude
```

A rule decides which agents move. It uses the `effort` that each agent file already has:

| Setting in `/config` | Default | What it does |
|---|---|---|
| Which agents use the cheap model | `low-effort agents` | `none`, `low-effort agents`, or `low- and medium-effort agents`. |
| Let cheap-model agents edit files | off | Off: only read-only agents move. |
| Cheap model (OpenCode model ID) | `openrouter/deepseek/deepseek-v4.1-flash` | Any `provider/model` from `opencode models`, for example a `vercel/...` model through Vercel AI Gateway. |
| Delegation timeout (s) | 540 | Stop waiting for a cheap-model agent after this. |

Agents that use MCP tools (Linear, Slack, Supabase, context7) or preload Claude Code skills always stay on Claude, because OpenCode does not have those. With the defaults, only read-only, low-effort agents without them move.

`/boomerang:external` lists every agent with its runtime and the reason. `/boomerang:external pin <agent> claude|opencode|auto` sets one agent by hand, and `auto` goes back to the rule. boomerang applies the rule at each session start, so a change takes effect in the next session.

What happens to your files:

- The original agent file is saved in `~/.claude/boomerang/originals/`, under its file name. That folder is outside the plugin's data folder, so uninstalling the plugin cannot delete it.
- A proxy with the same name and description takes its place in `~/.claude/agents`, and an OpenCode version goes to `~/.config/opencode/agents` (marked `managed by boomerang`).
- When an agent goes back to Claude, the original returns byte for byte.
- boomerang never overwrites an OpenCode agent of yours with the same name, and it leaves alone any agent files that share one `name:` (for example `scout.md` and `scout-old.md`).
- If you copy fresh agent files into `~/.claude/agents`, the next sync takes them as the new originals. Edits you make to a proxy itself are overwritten at the next sync; edit the original instead, or pin the agent to `claude` first.
- If boomerang cannot check the model (for example, `opencode models` does not answer), it changes nothing that time.

Each delegation runs one Bash command (`boomerang delegate <agent>`). Unless your permission mode allows it, Claude Code asks you to approve that command the first time.

## Names in Herdr

boomerang names what it creates, so you can find it in the Herdr sidebar:

| What | Name |
|---|---|
| The Codex pane and agent | `boomerang-codex` |
| The pane of a cheap-model agent | `boomerang-<agent>`, for example `boomerang-codebase-scout` |
| Your Claude agent, if it has no name | `boomerang-claude` |

A second one at the same time gets `-2`, `-3`, and so on. boomerang names Claude because Herdr gives a pane a new ID when you move it, but a name stays with the agent. So the hand-back finds Claude even if you move its pane. If your Claude already has a name, boomerang keeps it.

## Files

Everything goes into the plugin data folder (`~/.claude/plugins/data/boomerang-boomerang/`), not into your repo:

- `handoffs/<session>-<time>.md`: the handoff Claude wrote. Each handoff gets its own name.
- `handoffs/<session>-<time>.report.md`: the report Codex wrote.
- `usage/`, `state/`: usage snapshots and the handoff phase of each session.
- `errors.log`: anything that went wrong. boomerang never blocks Claude; it logs and goes on.

## When something goes wrong

- **The machine restarted while Codex worked.** The background process that does the hand-back is gone. The handoff and the report are still in the data folder. Tell Claude: "Read `<report path>`, review `git diff`, and continue."
- **Codex exits at once with "Cannot use the shared background server".** This happens when the Codex CLI and its background server have different versions. boomerang tries once more with `--no-daemon`. To fix it, update Codex (`codex update`), or add `--no-daemon` to Extra Codex arguments.
- **Codex asks a question.** Herdr shows it as `blocked`, and boomerang notifies you. boomerang never answers for Codex.
- **Codex's own startup screens.** boomerang starts Codex with `-c check_for_update_on_startup=false`, so the update screen does not appear, and our prompt cannot answer it. Your `~/.codex/config.toml` is not changed. Codex can also ask whether you trust a folder the first time it runs there. Herdr may count that screen as ready, and then boomerang's prompt could answer it. If you use Codex in a new folder, open Codex there once yourself first.
- **Claude is busy when its limit resets.** boomerang does not type into a busy agent. It notifies you, and you point Claude at the report.

## Undo

1. Set `statusLine` in `~/.claude/settings.json` back to your old command. It is in the data folder, in `chain.json`.
2. In `/config`, set "Which agents use the cheap model" to `none`, then run `/boomerang:external sync`. This puts every original agent file back.
3. `/plugin uninstall boomerang@boomerang`.

## Develop

```
npm install      # dev tools only: TypeScript, Node types, Biome
npm run check    # tests, type check, lint
```

The design and the plans are in `plans/` (the current ones are `v7-quiet-lighthouse.md` and `v8-patient-courier.md`).
