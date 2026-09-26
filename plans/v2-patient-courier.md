# relay v2: External delegation to cheap OpenCode models

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chosen agents run on a cheap OpenCode model in a reused Herdr pane, and report back to the Claude main agent as normal subagent results.

**Depends on:** v1-quiet-lighthouse (the launcher, `herdr.py`, `settings.py`). Build this after v1 is merged. The context, the verified facts and the shared file structure are in v1.

**Tech Stack:** Python 3 standard library, `unittest`, the Claude Code plugin system, the Herdr CLI and the OpenCode CLI.

**Commits:** hookify rules on this machine block the git commit and push commands. Each "Commit" step means: stage the changes and write down the commit message for the user.

---

## Part 3: External delegation to cheap OpenCode models

### Part 3 design decisions

- **Claude Code stays the one router.** We do not build a router. Claude Code already picks a subagent by its `description`. For an external agent, we replace its file in `~/.claude/agents/` with a **proxy** that has the **same name and the same description**, so routing does not change. The proxy runs on Haiku with `tools: Bash`, `maxTurns: 3` and `omitClaudeMd: true`. It calls `relay delegate <agent>` one time and returns the output as its result. So the result goes back to the main agent the same way as any subagent result. The proxy costs one small Haiku call per delegation. That is a hack, and we accept it because the other options are less reliable: a skill that the main agent must remember, or a `PreToolUse` hook that blocks the Agent tool and puts the result into the block message.
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

  A per-agent `relay-runtime: claude | opencode` in the agent's frontmatter overrides the rule. You set it with `/relay:external pin <agent> claude|opencode|auto`, so you do not need to know where the original file is. With the defaults, the rule picks `codebase-scout` and `log-digger`. `docs-researcher` is excluded because of its MCP tools, `ticket-scribe` because of its connectors, and `build-fixer` because it edits files.
- **Gateways do not matter.** OpenCode picks the credentials from the model ID prefix. At work, set `cheap_model` to a `vercel/...` ID. Setup and `sync` check the model against `opencode models`, and stop with a clear message ("connect the provider with /connect in OpenCode, or pick another model") when it is not there. Check during implementation that Claude Code ignores the unknown `relay-runtime` key. If it does not, keep the pins in `${CLAUDE_PLUGIN_DATA}/pins.json`. The `pin` command hides where the pins are stored, so users see no difference.
- **The rule is applied automatically.** `SessionStart` runs `sync`, so a change in `/config` takes effect in the next session. `sync` compares files and writes only what changed. It also handles the case where you copy the fleet from `~/Documents/agents` again: a live file without the proxy marker (`relay-proxy: true`) for an agent that should be external becomes the new original, and the proxy is written again.
- **Codex is not a routing target in v1.** Codex is used only for the limit handoff. High-effort work is where Claude's own models are worth the price. If we want it later, a Codex proxy works the same way, with `codex exec`.
- **One reused pane per agent, kept open.** In Herdr, `relay delegate` looks in the current workspace for a pane named `relay:<agent>` whose foreground program is the shell (`herdr pane process-info`). If one exists, it runs the task there, so the scrollback keeps the history. If there is none, or the pane is busy (two delegations at the same time), it opens a new pane (placement from `codex_placement`) and names it. Panes stay open, as you asked. Outside Herdr, it runs `opencode run` headless.
- **How we get the result back.** The task text goes to a temp file, so we have no shell quoting problems. The pane runs `opencode run --agent <a> -m <model> --dir <cwd> "$(cat <task file>)" 2>&1 | tee <report>; echo "RELAY_DONE:<id>:$?"`. Then `herdr pane wait-output <pane> --match RELAY_DONE:<id> --timeout <ms>` waits, and `relay delegate` prints the report with ANSI codes removed. The proxy runs the Bash call with a 600000 ms timeout. `relay delegate` gives up at 540 s and prints BLOCKED with the pane name, so the proxy always gets an answer before its own timeout.
- **Failures are explicit.** Model not available, OpenCode not installed, timeout, or a non-zero exit code: `relay delegate` exits non-zero with one line that says why. The proxy returns `BLOCKED: <reason>` and does not try the task itself. Your README rule applies: "if a cheap agent keeps returning BLOCKED, move it up a tier".
- **Limit: no claude.ai connectors in OpenCode.** Agents that need Linear, Slack or Supabase (`ticket-scribe`, `data-investigator`) cannot go external. The rule keeps any agent with `mcp__*` tools on Claude, and a pin cannot change that.

```
 main agent ── Agent(codebase-scout, "where is X resolved?")
                  │
                  v
 proxy subagent (Haiku, Bash only)
   Bash: relay delegate codebase-scout <<'RELAY_TASK' ... RELAY_TASK   (timeout 600 s)
                  │
                  v
 relay delegate ── model = cheap_model; check that it is available
     │
     ├── in Herdr: find free pane "relay:codebase-scout" or open one
     │      pane run: opencode run ... | tee report; echo RELAY_DONE:<id>:<exit>
     │      pane wait-output RELAY_DONE:<id>
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

## Chunk 4: External delegation

### Task 15: `agentdef.py`: read and write agent files

**Files:** Create `scripts/relay/agentdef.py`, `tests/fixtures/codebase-scout.md` (a copy of your real file). Test: `tests/test_agentdef.py`.

We parse only the flat YAML we write and read: `key: value` lines, comma lists, and `- item` lists (for `skills`). We do not add a YAML dependency. A file we cannot parse makes `on` refuse with a clear message. It never gets a half-parsed result.

- [ ] **Step 1: Failing tests.**
  - `test_parse_reads_frontmatter_and_body`: the fixture gives `name`, `description`, `model: haiku`, `tools` as a list, `disallowedTools` as a list, and a body that starts with the agent's first paragraph.
  - `test_opencode_definition_maps_permissions_and_keeps_body`: `to_opencode(agent)` has `description`, `mode`, `permission.edit: deny` (because of `disallowedTools: Write, Edit`) and the relay intro line followed by the original body.
  - `test_proxy_definition_keeps_name_and_description`: `to_proxy(agent, launcher_path)` has the same `name` and `description`, `model: haiku`, `tools: Bash`, `maxTurns: 3`, `omitClaudeMd: true`, and a body that holds the launcher path and the agent name.
  - `test_runtime_rule_with_defaults_matches_the_fleet`: this test runs over copies of all 16 real agent files. With the default policy, `runtime_for` gives `OPENCODE` only for `codebase-scout` and `log-digger`. Every other agent gets `CLAUDE`, each with the right reason: `docs-researcher` has MCP tools, `ticket-scribe` has MCP tools, `build-fixer` edits files, and `implementer` has medium effort.
  - `test_runtime_rule_widened`: with `low- and medium-effort agents` and `can_edit_files=True`, `implementer`, `test-runner` and `build-fixer` get `OPENCODE`. `data-investigator` stays on `CLAUDE` (MCP tools), and `plan-executor` stays on `CLAUDE` (high effort).
  - `test_pin_overrides_rule`: `relay-runtime: claude` on the scout gives `CLAUDE`. `relay-runtime: opencode` on an agent with MCP tools still gives `CLAUDE` with the reason "needs MCP tools". A pin cannot send an agent where it cannot work.
  - `test_proxy_marker_is_detected`: `is_proxy(to_proxy(...))` is True, and it is False for the original.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `AgentDef(frontmatter: dict, body: str, path: Path)`, `parse(path)`, `render(frontmatter, body) -> str`, `to_opencode`, `to_proxy` (fills `templates/proxy-agent.md` and adds `relay-proxy: true`), `is_proxy`, and the rule:

```python
class Runtime(str, Enum):
    CLAUDE = "claude"
    OPENCODE = "opencode"


@dataclass(frozen=True)
class RuntimeChoice:
    runtime: Runtime
    reason: str  # shown by `/relay:external list`, for example "low effort, read-only"


@dataclass(frozen=True)
class CheapModelPolicy:
    max_effort: Optional[str]  # None for "none", "low" or "medium"
    can_edit_files: bool


EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"]


def runtime_for(agent: AgentDef, policy: CheapModelPolicy) -> RuntimeChoice:
    if agent.uses_mcp_tools:
        return RuntimeChoice(Runtime.CLAUDE, "needs MCP tools that OpenCode does not have")
    pin = agent.frontmatter.get("relay-runtime")
    if pin in (Runtime.CLAUDE.value, Runtime.OPENCODE.value):
        return RuntimeChoice(Runtime(pin), f"pinned to {pin}")
    if not _effort_is_cheap(agent.effort, policy.max_effort):
        return RuntimeChoice(Runtime.CLAUDE, f"{agent.effort} effort")
    if agent.can_edit_files and not policy.can_edit_files:
        return RuntimeChoice(Runtime.CLAUDE, "edits files")
    return RuntimeChoice(Runtime.OPENCODE, f"{agent.effort} effort, " + ("edits files" if agent.can_edit_files else "read-only"))
```

  `agent.effort` defaults to `medium` when the file has no `effort`, which is the Claude Code default. `uses_mcp_tools` and `can_edit_files` are properties that read `tools` and `disallowedTools`. We check the positive facts directly, and do not guess them from missing fields.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: agent definition conversion`.

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
color: {{color}}
---

You are a relay for the {{name}} agent. Do not do the task yourself.

Run this one Bash command, with the timeout set to 600000, and put the full task you received between the markers without changes:

    '{{launcher}}' delegate {{name}} <<'RELAY_TASK'
    <the full task you received>
    RELAY_TASK

When the command succeeds, return its output as your whole answer, without changes.
When it fails, return "BLOCKED: " and the error line. Do not try the task another way.
```

### Task 16: `herdr.py` additions for reused panes

**Files:** Modify `scripts/relay/herdr.py`. Test: `tests/test_herdr.py`.

- [ ] **Step 1: Failing tests.**
  - `test_find_free_named_pane`: when `herdr pane list` returns two panes named `relay:codebase-scout` and `pane process-info` says the first one runs `opencode` and the second one runs `zsh`, `find_free_pane(ws, "relay:codebase-scout", run)` returns the second one. It returns `None` when none is free.
  - `test_wait_for_marker_passes_timeout`: `wait_output(pane, "RELAY_DONE:abc", 540_000, run)` calls `herdr pane wait-output <pane> --match RELAY_DONE:abc --timeout 540000`.
- [ ] **Step 2:** See them fail. Before Step 3, check the real JSON shapes of `herdr pane list` and `herdr pane process-info` (pane label and foreground process name). Put the real outputs in the test fixtures.
- [ ] **Step 3: Implement** `find_free_pane`, `open_pane(ctx, placement, cwd, label, run)` (move the split/tab code from `open_codex_pane` here, and keep `open_codex_pane` as a one-line call to it with label `codex-handoff`), `run_in_pane`, and `wait_output`.
- [ ] **Step 4:** All Herdr tests pass, the old ones too. **Step 5:** Commit `feat: reusable named panes`.

### Task 17: `delegate.py`: run the external agent

**Files:** Create `scripts/relay/delegate.py`. Test: `tests/test_delegate.py`.

- [ ] **Step 1: Failing tests** (fake runner, fake headless runner, temp data folder):
  - `test_in_herdr_reuses_free_pane_and_returns_clean_report`: a free `relay:codebase-scout` pane exists. The command sent to it has `opencode run --agent codebase-scout -m <model> --dir <cwd>`, the `tee` to the report and the `RELAY_DONE:<id>` line. The report file has ANSI codes, and the returned text has none.
  - `test_opens_new_pane_when_named_pane_is_busy`.
  - `test_outside_herdr_runs_headless`: the headless runner gets the same `opencode run` arguments, and its stdout is the result.
  - `test_unavailable_model_fails_before_running`: `opencode models` output without the model gives exit 2 and one line that names the model and says to run `/connect`. No pane is opened.
  - `test_non_zero_exit_or_timeout_is_blocked`: `RELAY_DONE:<id>:1` gives exit 1 and the last 20 lines of the report. A wait timeout gives exit 1 and the message "still running in pane relay:codebase-scout".
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `main(argv, stdin, env, run, headless, now) -> int`. Read the task from stdin. The model is `cheap_model`. Load the options from the plugin settings in `settings.json` (`pluginConfigs["relay@relay"].options`, with the manifest defaults), because the launcher is not a hook and does not get `CLAUDE_PLUGIN_OPTION_*`. Find the model, check it (cache the `opencode models` list in the data folder for 10 minutes, because it is slow), then run it in Herdr or headless. Report files go to `<data>/delegations/<timestamp>-<agent>.md`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: delegate to opencode agents`.

### Task 18: `/relay:external` command

**Files:** Create `commands/external.md`, `scripts/external_agents.py`. Test: `tests/test_external_agents.py`.

- [ ] **Step 1: Failing tests** (temp `HOME` for `~/.claude/agents` and `~/.config/opencode/agents`):
  - `test_sync_moves_original_writes_proxy_and_opencode_agent`: with the default policy, after `sync` the scout's original is in `originals/`, the Claude file is the proxy, and the OpenCode file exists.
  - `test_sync_restores_original_when_policy_says_claude`: after `sync` with `none`, the Claude file is byte-for-byte the original, and the OpenCode file is gone.
  - `test_sync_is_idempotent`: a second `sync` changes no file, and it never moves the proxy over the saved original. That would lose the original, so this test protects against the worst bug here.
  - `test_recopied_fleet_file_becomes_new_original`: overwrite the proxy with a new original (as a fresh copy from `~/Documents/agents` would), run `sync`, and check that `originals/` has the new content and the proxy is back.
  - `test_pin_writes_frontmatter_and_syncs`: `pin log-digger claude` sets `relay-runtime: claude` in the original, and `log-digger` is native again. `pin log-digger auto` removes the key.
  - `test_unavailable_model_skips_proxies`: when `opencode models` does not list `cheap_model`, `sync` writes no proxy, keeps every agent native, and reports why. A proxy that can only return BLOCKED is worse than a native agent.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.** `list` shows each agent with its runtime, reason and model. `sync` applies `runtime_for` to every agent and checks the model once. `pin <agent> claude|opencode|auto` edits the original and runs `sync`. `external.md` tells Claude to run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/external_agents.py" <args> --data "${CLAUDE_PLUGIN_DATA}"` and to show the result. `on_session_start.py` runs `sync` quietly (no output unless something changed or failed). `/relay:setup` runs it too. When `opencode` is not installed, both say one time that external delegation is off, and they keep all agents native.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: relay:external command`.

### Task 19: End-to-end check of delegation

- [ ] Run `/relay:external list`. Expected: `codebase-scout` and `log-digger` show `opencode (low effort, read-only)`, and every other agent shows `claude` with its reason. Start a new Claude session in a Herdr pane in a Leap repo. `/agents` shows `codebase-scout` on Haiku with the same description.
- [ ] Ask "where is the partner credential resolved?". Expected: Claude routes to `codebase-scout`, a pane named `relay:codebase-scout` opens and shows `opencode run` with the DeepSeek model, and the main agent gets back a list of paths.
- [ ] Ask a second scout question. Expected: the same pane is used, and the scrollback shows both runs.
- [ ] Ask two scout questions at the same time (in parallel subagents). Expected: a second `relay:codebase-scout` pane opens.
- [ ] In `/config`, set `cheap_model` to a model that is not connected, and start a new session. Expected: `SessionStart` says that the model is not available, and the scout is native again. Then run `/relay:external pin log-digger claude`, set the model back, and start a new session. Expected: only `codebase-scout` is external.
- [ ] Outside Herdr (a normal terminal): the same question runs headless and returns the paths.
- [ ] Check the OpenRouter usage page, and compare the cost per scout call with the Haiku baseline from Part 1.
- [ ] Run `/relay:external pin codebase-scout claude`, start a new session, and check that `/agents` shows the original again. Then run `pin codebase-scout auto`.
