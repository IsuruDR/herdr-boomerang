# boomerang v8: External delegation to cheap OpenCode models (TypeScript, Herdr naming)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

This replaces `v6-patient-courier.md`. Only the name changed: the plugin is now **boomerang**, and panes use the `boomerang-<agent>` names from v7.

**Goal:** Chosen agents run on a cheap OpenCode model in a reused Herdr pane, and report back to the Claude main agent as normal subagent results.

**Depends on:** `v7-quiet-lighthouse.md` (the `run.mjs` guard, the launcher, `herdr.ts` with `openPane`, `runInPane` and `waitForOutput`, `names.ts`, `settings.ts`). Build this after v7 is merged. The context, the verified facts and the shared file structure are in v7.

**Tech Stack:** Node 22.18+ with `.ts` files (type stripping), `node:test`, the Claude Code plugin system, the Herdr CLI and the OpenCode CLI. No runtime dependencies.

**Commits:** hookify rules on this machine block the git commit and push commands. Each "Commit" step means: stage the changes and write down the commit message for the user.

---

## Design decisions

- **Claude Code stays the one router.** We do not build a router. Claude Code already picks a subagent by its `description`. For an external agent, we replace its file in `~/.claude/agents/` with a **proxy** that has the **same name and the same description**, so routing does not change. The proxy runs on Haiku with `tools: Bash`, `maxTurns: 3` and `omitClaudeMd: true`. It calls `boomerang delegate <agent>` one time and returns the output as its result. So the result goes back to the main agent the same way as any subagent result. The proxy costs one small Haiku call per delegation. That is a hack, and we accept it because the other options are less reliable: a skill that the main agent must remember, or a `PreToolUse` hook that blocks the Agent tool and puts the result into the block message.
- **The real agent runs in OpenCode.** For each agent that the rule sends to the cheap model, `sync` reads the original Claude agent file and generates `~/.config/opencode/agents/<agent>.md`:
  - `description` is copied.
  - `mode: all`, so `opencode run --agent` accepts it. Check this during implementation. If `mode: subagent` is enough, use that.
  - `disallowedTools: Write, Edit, ...` becomes `permission: { edit: deny }`.
  - The body is copied, with one line added at the top: "You run inside OpenCode for a Claude Code main agent. Your final message is the report it receives."
  The original Claude file moves to `${CLAUDE_PLUGIN_DATA}/originals/<agent>.md`, and `sync` restores it when the rule or a pin sends the agent back to Claude. Nothing is lost, and you can undo it at any time.
- **A rule decides which agents use the cheap model, not the main agent on each prompt.** Claude choosing a runtime for every prompt would cost tokens each time, the results would be hard to predict, and you could not debug them. Claude's choice of agent already tells us what kind of task it is. So the runtime belongs to the agent. The rule uses the `effort` that each agent file already has, and three settings:

  | Setting | Title in `/config` | Values | Default |
  |---|---|---|---|
  | `cheap_model_agents` | Which agents use the cheap model | `none` / `low-effort agents` / `low- and medium-effort agents` | `low-effort agents` |
  | `cheap_model_can_edit_files` | Let cheap-model agents edit files | on / off | off |
  | `cheap_model` | Cheap model (OpenCode model ID) | `provider/model`, for example `openrouter/...` or `vercel/...` | `openrouter/deepseek/deepseek-v4.1-flash` |

  An agent runs on the cheap model when all of these are true:
  1. Its effort is inside `cheap_model_agents`.
  2. It has no MCP tools. OpenCode does not have your claude.ai connectors or your context7 setup.
  3. It cannot edit files (`disallowedTools` has `Write` and `Edit`), or `cheap_model_can_edit_files` is on.

  A per-agent `boomerang-runtime: claude | opencode` in the agent's frontmatter overrides the rule. You set it with `/boomerang:external pin <agent> claude|opencode|auto`, so you do not need to know where the original file is. With the defaults, the rule picks `codebase-scout` and `log-digger`. `docs-researcher` is excluded because of its MCP tools, `ticket-scribe` because of its connectors, and `build-fixer` because it edits files.
- **Gateways do not matter.** OpenCode picks the credentials from the model ID prefix. At work, set `cheap_model` to a `vercel/...` ID. Setup and `sync` check the model against `opencode models`, and stop with a clear message ("connect the provider with /connect in OpenCode, or pick another model") when it is not there. Check during implementation that Claude Code ignores the unknown `boomerang-runtime` key. If it does not, keep the pins in `${CLAUDE_PLUGIN_DATA}/pins.json`. The `pin` command hides where the pins are stored, so users see no difference.
- **The rule is applied automatically.** `SessionStart` runs `sync`, so a change in `/config` takes effect in the next session. `sync` compares files and writes only what changed. It also handles the case where you copy the fleet from `~/Documents/agents` again: a live file without the proxy marker (`boomerang-proxy: true`) for an agent that should be external becomes the new original, and the proxy is written again.
- **Codex is not a routing target here.** Codex is used only for the limit handoff. High-effort work is where Claude's own models are worth the price. If we want it later, a Codex proxy works the same way, with `codex exec`.
- **One reused pane per agent, kept open.** In Herdr, `boomerang delegate` looks in the current workspace for a pane labelled `boomerang-<agent>` (for example `boomerang-codebase-scout`, from `boomerangName` in v7) whose foreground program is the shell (`herdr pane process-info`). If one exists, it runs the task there, so the scrollback keeps the history. If there is none, or the pane is busy (two delegations at the same time), it opens a new pane (placement from `codex_placement`) and labels it with the next free name (`boomerang-codebase-scout-2`). Panes stay open, as you asked. Outside Herdr, it runs `opencode run` headless.
- **Why `opencode run` and not a named Herdr agent.** For Codex (v7) we use `herdr agent start` and `agent prompt --wait`. For delegation we cannot: we must get the answer back as text, `herdr agent read` cannot get back text that scrolled off the OpenCode screen, and a read-only agent cannot write a report file. So the pane runs the headless `opencode run`, and we capture its stdout. The pane still has a `boomerang-` label, so it is easy to find in the sidebar.
- **How we get the result back.** The task text goes to a temp file, so we have no shell quoting problems. The pane runs `opencode run --agent <a> -m <model> --dir <cwd> "$(cat <task file>)" 2>&1 | tee <report>; printf 'BOOMERANG_%s:%s:%s\n' DONE <id> $?`. The marker is printed from parts, because `herdr pane wait-output` also searches the command line on the screen, and a literal `BOOMERANG_DONE:<id>` in the command would match at once. Then `waitForOutput(pane, 'BOOMERANG_DONE:<id>:(\d+)', <ms>)` waits, and `boomerang delegate` prints the report with ANSI codes removed. The proxy runs the Bash call with a 600000 ms timeout. `boomerang delegate` gives up at 540 s and prints BLOCKED with the pane name, so the proxy always gets an answer before its own timeout.
- **Failures are explicit.** Model not available, OpenCode not installed, timeout, or a non-zero exit code: `boomerang delegate` exits non-zero with one line that says why. The proxy returns `BLOCKED: <reason>` and does not try the task itself. Your README rule applies: "if a cheap agent keeps returning BLOCKED, move it up a tier".
- **Limit: no claude.ai connectors in OpenCode.** Agents that need Linear, Slack or Supabase (`ticket-scribe`, `data-investigator`) cannot go external. The rule keeps any agent with `mcp__*` tools on Claude, and a pin cannot change that.

```
 main agent ── Agent(codebase-scout, "where is X resolved?")
                  │
                  v
 proxy subagent (Haiku, Bash only)
   Bash: boomerang delegate codebase-scout <<'BOOMERANG_TASK' ... BOOMERANG_TASK   (timeout 600 s)
                  │
                  v
 boomerang delegate ── model = cheap_model; check that it is available
     │
     ├── in Herdr: find free pane "boomerang-codebase-scout" or open one
     │      pane run: opencode run ... | tee report; printf BOOMERANG_DONE:<id>:<exit>
     │      pane wait-output --regex BOOMERANG_DONE:<id>:(\d+)
     └── not in Herdr: opencode run ... (headless, captured)
                  │
                  v
 report text (ANSI removed) -> stdout -> proxy result -> main agent
```

New `userConfig` fields in `plugin.json`:

```json
"cheap_model_agents": {
  "type": "string", "title": "Which agents use the cheap model",
  "description": "Agents at or below this effort run on the cheap model in OpenCode. Agents with MCP tools always stay on Claude.",
  "options": ["none", "low-effort agents", "low- and medium-effort agents"],
  "default": "low-effort agents"
},
"cheap_model_can_edit_files": {
  "type": "boolean", "title": "Let cheap-model agents edit files",
  "description": "Off: only read-only agents use the cheap model. On: agents that edit files can use it too.",
  "default": false
},
"cheap_model": {
  "type": "string", "title": "Cheap model (OpenCode model ID)",
  "description": "provider/model as listed by `opencode models`, for example openrouter/... or vercel/...",
  "default": "openrouter/deepseek/deepseek-v4.1-flash"
},
"delegate_timeout_seconds": {
  "type": "number", "title": "Delegation timeout (s)",
  "description": "Stop waiting for an external agent after this many seconds",
  "default": 540, "min": 60, "max": 580
}
```

New files:

```
boomerang/
  commands/external.md              /boomerang:external (list, sync, pin <agent> claude|opencode|auto)
  templates/proxy-agent.md          proxy subagent template
  scripts/
    entries/delegate.ts             `boomerang delegate <agent>` (called by proxies through the launcher)
    entries/external.ts             run by /boomerang:external and by session-start
    lib/agentdef.ts                 parse and write agent Markdown, the runtime rule
    lib/delegate.ts                 run an OpenCode agent in a reused pane or headless
    lib/external.ts                 sync, pin and list logic
  tests/
    fixtures/agents/*.md            copies of the 16 real agent files
    agentdef.test.ts  delegate.test.ts  external.test.ts
```

## Chunk 4: External delegation

### Task 15: `agentdef.ts`: read and write agent files, and the runtime rule

**Files:** Create `scripts/lib/agentdef.ts`, `templates/proxy-agent.md`, `tests/fixtures/agents/` (copies of your 16 files). Test: `tests/agentdef.test.ts`.

We parse only the flat YAML that agent files use: `key: value` lines, comma lists, and `- item` lists (for `skills`). We do not add a YAML dependency. A file we cannot parse makes `sync` skip that agent with a clear message. It never gets a half-parsed result.

- [ ] **Step 1: Failing tests.**
  - `parse reads frontmatter and body`: the scout fixture gives `name`, `description`, `model: haiku`, `tools` as a list, `disallowedTools` as a list, and a body that starts with the agent's first paragraph.
  - `OpenCode definition maps permissions and keeps the body`: `toOpenCode(agent)` has `description`, `mode`, `permission.edit: deny` (because of `disallowedTools: Write, Edit`) and the boomerang intro line followed by the original body.
  - `proxy definition keeps name and description`: `toProxy(agent, launcherPath)` has the same `name` and `description`, `model: haiku`, `tools: Bash`, `maxTurns: 3`, `omitClaudeMd: true`, `boomerang-proxy: true`, and a body that holds the launcher path and the agent name.
  - `runtime rule with defaults matches the fleet`: this test runs over all 16 fixtures. With the default policy, `runtimeFor` gives `opencode` only for `codebase-scout` and `log-digger`. Every other agent gets `claude`, each with the right reason: `docs-researcher` and `ticket-scribe` have MCP tools, `build-fixer` edits files, and `implementer` has medium effort.
  - `runtime rule widened`: with `low- and medium-effort agents` and `canEditFiles: true`, `implementer`, `test-runner` and `build-fixer` get `opencode`. `data-investigator` stays on `claude` (MCP tools), and `plan-executor` stays on `claude` (high effort).
  - `pin overrides the rule`: `boomerang-runtime: claude` on the scout gives `claude`. `boomerang-runtime: opencode` on an agent with MCP tools still gives `claude` with the reason "needs MCP tools". A pin cannot send an agent where it cannot work.
  - `proxy marker is detected`: `isProxy(parse(toProxy(...)))` is true, and it is false for the original.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `interface AgentDef { frontmatter: Record<string, string | string[]>; body: string; path: string }`, `parseAgent(path)`, `renderAgent(frontmatter, body)`, `toOpenCode`, `toProxy` (fills `templates/proxy-agent.md`), `isProxy`, and the rule:

```ts
export const Runtime = { Claude: "claude", OpenCode: "opencode" } as const;
export type Runtime = (typeof Runtime)[keyof typeof Runtime];

export interface RuntimeChoice {
  runtime: Runtime;
  reason: string; // shown by `/boomerang:external list`, for example "low effort, read-only"
}

export const CheapModelAgents = {
  None: "none",
  LowEffort: "low-effort agents",
  LowAndMediumEffort: "low- and medium-effort agents",
} as const;
export type CheapModelAgents = (typeof CheapModelAgents)[keyof typeof CheapModelAgents];

export interface CheapModelPolicy {
  agents: CheapModelAgents;
  canEditFiles: boolean;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const MAX_CHEAP_EFFORT: Record<CheapModelAgents, string | undefined> = {
  [CheapModelAgents.None]: undefined,
  [CheapModelAgents.LowEffort]: "low",
  [CheapModelAgents.LowAndMediumEffort]: "medium",
};

export function runtimeFor(agent: AgentDef, policy: CheapModelPolicy): RuntimeChoice {
  if (usesMcpTools(agent)) return { runtime: Runtime.Claude, reason: "needs MCP tools that OpenCode does not have" };
  const pin = agent.frontmatter["boomerang-runtime"];
  if (pin === Runtime.Claude || pin === Runtime.OpenCode) return { runtime: pin, reason: `pinned to ${pin}` };
  const effort = effortOf(agent);
  if (!effortIsCheap(effort, MAX_CHEAP_EFFORT[policy.agents])) return { runtime: Runtime.Claude, reason: `${effort} effort` };
  const edits = canEditFiles(agent);
  if (edits && !policy.canEditFiles) return { runtime: Runtime.Claude, reason: "edits files" };
  return { runtime: Runtime.OpenCode, reason: `${effort} effort, ${edits ? "edits files" : "read-only"}` };
}

function effortIsCheap(effort: string, maxCheapEffort: string | undefined): boolean {
  return maxCheapEffort !== undefined && EFFORT_ORDER.indexOf(effort) <= EFFORT_ORDER.indexOf(maxCheapEffort);
}
```

  `effortOf` returns `medium` when the file has no `effort`, which is the Claude Code default. `usesMcpTools` checks `tools` for entries that start with `mcp__`. `canEditFiles` is true unless `disallowedTools` has both `Write` and `Edit`. We check the positive facts directly, and do not guess them from missing fields.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: agent definition conversion and runtime rule`.

`templates/proxy-agent.md`:

```markdown
---
name: {{name}}
description: {{description}}
tools: Bash
model: haiku
effort: low
maxTurns: 3
omitClaudeMd: true
boomerang-proxy: true
color: {{color}}
---

You are a boomerang for the {{name}} agent. Do not do the task yourself.

Run this one Bash command, with the timeout set to 600000, and put the full task you received between the markers without changes:

    '{{launcher}}' delegate {{name}} <<'BOOMERANG_TASK'
    <the full task you received>
    BOOMERANG_TASK

When the command succeeds, return its output as your whole answer, without changes.
When it fails, return "BLOCKED: " and the error line. Do not try the task another way.
```

### Task 16: `herdr.ts` additions for reused panes

**Files:** Modify `scripts/lib/herdr.ts`. Test: `tests/herdr.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `finds the free labelled pane`: when `pane list` returns two panes labelled `boomerang-codebase-scout` and `boomerang-codebase-scout-2`, and `pane process-info --pane <id>` says the first one runs `opencode` and the second one runs `zsh`, `findFreePane(ctx, "boomerang-codebase-scout", run)` returns the second one. It returns `undefined` when none is free. Labels that only start with the base name but belong to another agent (`boomerang-codebase-scout-extra`) do not count: a match is the base name, or the base name plus `-<number>`.
- [ ] **Step 2:** See them fail. Before Step 3, label a test pane with `herdr pane rename` and save the real JSON of `herdr pane list` (where the label shows) and `herdr pane process-info --pane <id>` (`.result.process_info.foreground_processes[].name`) as fixtures. The `pane list` output we saw had no label field for panes without a label, so the fixture must come from a labelled pane.
- [ ] **Step 3: Implement** `findFreePane`. `openPane`, `runInPane` and `waitForOutput` already exist from v7 Task 6. Shells to treat as "free": `zsh`, `bash`, `fish`, `sh`.
- [ ] **Step 4:** All Herdr tests pass, the old ones too. **Step 5:** Stage. Commit message: `feat: reusable named panes`.

### Task 17: `delegate.ts`: run the external agent

**Files:** Create `scripts/lib/delegate.ts`, `scripts/entries/delegate.ts`. Test: `tests/delegate.test.ts`.

- [ ] **Step 1: Failing tests** (fake runner, fake headless runner, temp data folder):
  - `in Herdr, reuses the free pane and returns a clean report`: a free `boomerang-codebase-scout` pane exists. The command sent to it has `opencode run --agent codebase-scout -m <model> --dir <cwd>`, the `tee` to the report and the `printf` marker, and it does **not** contain the literal `BOOMERANG_DONE:<id>`. The report file has ANSI codes, and the returned text has none.
  - `opens boomerang-codebase-scout-2 when boomerang-codebase-scout is busy`.
  - `outside Herdr, runs headless`: the headless runner gets the same `opencode run` arguments, and its stdout is the result.
  - `unavailable model fails before running`: `opencode models` output without the model gives exit 2 and one line that names the model and says to run `/connect`. No pane is opened.
  - `non-zero exit or timeout is blocked`: `BOOMERANG_DONE:<id>:1` gives exit 1 and the last 20 lines of the report. A wait timeout gives exit 1 and the message "still running in pane boomerang-codebase-scout".
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `delegate({ agent, task, env, run, headless, now, dataDir }): Promise<DelegateResult>`, where `DelegateResult` is `{ kind: "done", report }`, `{ kind: "failed", reason, tail }` or `{ kind: "unavailable", reason }`. Three named outcomes, so the entry does not guess from an exit code. The entry reads the task from stdin, prints the result, and maps the outcomes to exit codes 0, 1 and 2. The model is `cheap_model`. Load the options with `pluginOptions(SETTINGS_PATH, PLUGIN_ID)` plus the manifest defaults, because the launcher is not a hook and does not get `CLAUDE_PLUGIN_OPTION_*`. Cache the `opencode models` list in the data folder for 10 minutes, because it is slow. Report files go to `<data>/delegations/<timestamp>-<agent>.md`.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: delegate to opencode agents`.

### Task 18: `/boomerang:external` command

**Files:** Create `commands/external.md`, `scripts/lib/external.ts`, `scripts/entries/external.ts`. Modify `scripts/entries/session-start.ts`, `scripts/entries/setup.ts`. Test: `tests/external.test.ts`.

- [ ] **Step 1: Failing tests** (temp `HOME` for `~/.claude/agents` and `~/.config/opencode/agents`):
  - `sync moves the original, writes the proxy and the OpenCode agent`: with the default policy, after `sync` the scout's original is in `originals/`, the Claude file is the proxy, and the OpenCode file exists.
  - `sync restores the original when the policy says claude`: after `sync` with `none`, the Claude file is byte-for-byte the original, and the OpenCode file is gone.
  - `sync is idempotent`: a second `sync` changes no file, and it never moves the proxy over the saved original. That would lose the original, so this test protects against the worst bug here.
  - `a re-copied fleet file becomes the new original`: overwrite the proxy with a new original (as a fresh copy from `~/Documents/agents` would), run `sync`, and check that `originals/` has the new content and the proxy is back.
  - `pin writes frontmatter and syncs`: `pin log-digger claude` sets `boomerang-runtime: claude` in the original, and `log-digger` is native again. `pin log-digger auto` removes the key.
  - `unavailable model skips proxies`: when `opencode models` does not list `cheap_model`, `sync` writes no proxy, keeps every agent native, and reports why. A proxy that can only return BLOCKED is worse than a native agent.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.** `list` shows each agent with its runtime, reason and model. `sync` applies `runtimeFor` to every agent and checks the model one time. `pin <agent> claude|opencode|auto` edits the original and runs `sync`. `external.md` tells Claude to run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" external <args> --data "${CLAUDE_PLUGIN_DATA}"` and to show the result. `session-start.ts` runs `sync` quietly (no output unless something changed or failed). `setup.ts` runs it too. When `opencode` is not installed, both say one time that external delegation is off, and they keep all agents native.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: boomerang:external command`.

### Task 19: End-to-end check of delegation

- [ ] Run `/boomerang:external list`. Expected: `codebase-scout` and `log-digger` show `opencode (low effort, read-only)`, and every other agent shows `claude` with its reason. Start a new Claude session in a Herdr pane in a Leap repo. `/agents` shows `codebase-scout` on Haiku with the same description.
- [ ] Ask "where is the partner credential resolved?". Expected: Claude routes to `codebase-scout`, a pane labelled `boomerang-codebase-scout` opens and shows `opencode run` with the DeepSeek model, and the main agent gets back a list of paths.
- [ ] Ask a second scout question. Expected: the same pane is used, and the scrollback shows both runs.
- [ ] Ask two scout questions at the same time (in parallel subagents). Expected: a second pane, `boomerang-codebase-scout-2`, opens.
- [ ] In `/config`, set `cheap_model` to a model that is not connected, and start a new session. Expected: `SessionStart` says that the model is not available, and the scout is native again. Then run `/boomerang:external pin log-digger claude`, set the model back, and start a new session. Expected: only `codebase-scout` is external.
- [ ] Outside Herdr (a normal terminal): the same question runs headless and returns the paths.
- [ ] Check the OpenRouter usage page, and compare the cost per scout call with the Haiku baseline from Part 1.
- [ ] Run `/boomerang:external pin codebase-scout claude`, start a new session, and check that `/agents` shows the original again. Then run `pin codebase-scout auto`.
- [ ] Run `npm test`, `npm run typecheck` and `npm run lint`. Then run the superpowers:requesting-code-review review against `git diff main --stat`, iterate once, and list any open issues.
