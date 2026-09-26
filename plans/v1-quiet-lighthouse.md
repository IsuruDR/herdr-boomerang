# relay: Agent Fleet, Limit Handoff and External Delegation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code stays the one main agent and sends each piece of work to the cheapest agent that can do it well. Claude models run as native subagents, and read-only work runs on cheap OpenCode models in Herdr panes. When Claude gets close to its usage limit, it hands the work to Codex and takes it back after the reset. Every agent reports back to the Claude main agent.

**Architecture:** There are three parts, built in this order:

1. **Turn on the agent fleet.** This is config only: copy `~/Documents/agents/*.md` to `~/.claude/agents/`. Claude Code then routes by each agent's `description`, and subagent results go back to the main agent.
2. **The `relay` plugin core and the limit handoff.** A shared Herdr core runs an external agent in a pane and gets a report back. The first feature uses it for the limit handoff to Codex, and for the hand-back.
3. **External delegation.** The second feature uses the same core. Chosen agents (first `codebase-scout` and `log-digger`) become tiny proxy subagents that run the real agent through `opencode run` on a cheap model, in a reused Herdr pane, and return the report.


**Commits:** hookify rules on this machine block the git commit and push commands. Each "Commit" step means: stage the changes and write down the commit message for the user.

**Tech Stack:** Python 3 standard library only (works with macOS `/usr/bin/python3` 3.9, so every module starts with `from __future__ import annotations`), `unittest`, the Claude Code plugin system (hooks, `userConfig`, commands), the Herdr CLI, the Codex CLI and the OpenCode CLI. Lint and format with `uvx ruff`.

---

## Context

You use Claude Code as your main agent, Codex as the second one, and OpenCode with OpenRouter (personal) or Vercel AI Gateway (work) for cheap models. Your transcript analysis in `~/Documents/agents/00-README.md` shows that 96% of the tokens are cache reads, and that the median turn re-reads 242K tokens. So the biggest saving is to move work into agents with a small context. A cheaper model gives more savings on top.

Your 16 agent files are native Claude Code subagent definitions (`name`, `description`, `model`, `tools`, `effort`, `skills`). They do nothing today, because `~/.claude/agents` does not exist. Part 1 fixes that with no code. A Claude Code subagent can run only Claude models, so the non-Claude models need OpenCode. Parts 2 and 3 build that bridge, and it also serves the Codex limit handoff.

```
 your prompt
     │
 Claude Code main agent ── picks an agent by its description (native routing)
     │
     ├── Claude-model agent (brainstorm-partner, plan-writer, implementer, ...)
     │        native subagent ─────────────────────────────> result back to main
     │
     ├── external agent (codebase-scout, log-digger)
     │        tiny proxy subagent (Haiku, Bash only, small context)
     │        runs the relay delegate command
     │           └── `opencode run --agent <name> -m <cheap model>`
     │               in the reused Herdr pane "relay:<name>", output saved to a report
     │        proxy returns the report ────────────────────> result back to main
     │
     └── near the usage limit (automatic, not routed)
              Claude writes a handoff -> Codex in a Herdr pane
              Codex report -> hand back to Claude after the reset
```

We package parts 2 and 3 as one plugin, so other people can install it. We checked the facts in the current docs (Claude Code 2.1.282, Codex 0.157, Herdr 0.9.0, OpenCode 1.18.31):

- The status line JSON has `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`. It shows only for Pro/Max subscriptions. Hooks do not get these values.
- A plugin **cannot** set the main status line. It can set only `agent` and `subagentStatusLine`. So we need a one-time `/relay:setup` command.
- `PostToolBatch` can return `additionalContext`, which Claude reads before its next model call. This is how we warn Claude in the middle of a long turn.
- `Stop` can return `decision: "block"` with a `reason`, and it gets `last_assistant_message` and `stop_hook_active`. Claude Code limits this to 8 blocks in a row.
- `StopFailure` gets `error: "rate_limit"`. It ignores output except `terminalSequence`, so it can only run side effects.
- `userConfig` gives us settings that users pick at install time and can change in `/config`. Hooks read them as `CLAUDE_PLUGIN_OPTION_<KEY>`. Stored values go to `pluginConfigs["<plugin>@<marketplace>"].options` in `~/.claude/settings.json`.
- `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) stays the same across plugin updates. `${CLAUDE_PLUGIN_ROOT}` changes with each version.
- OpenCode reads custom agents from Markdown files in `~/.config/opencode/agents/`, with `description`, `mode`, `model` and `permission` in the frontmatter and the prompt in the body. `opencode run --agent <name> -m <provider/model> --dir <path> "<task>"` runs one task headless. `opencode models` lists only the models of connected providers.
- OpenCode resolves the credentials from the `provider/` prefix of the model ID. `openrouter/...` goes through OpenRouter and `vercel/...` through Vercel AI Gateway. So the plugin does not need to know which gateway you use. It passes a model ID and checks that `opencode models` lists it.

## Part 1: Turn on the agent fleet (config only, before any code)

This gives most of the savings and needs no plugin.

- [ ] **Step 1:** Run `mkdir -p ~/.claude/agents && cp ~/Documents/agents/[a-z]*.md ~/.claude/agents/`. This copies the 16 agents and leaves out `00-README.md`, which has no frontmatter. After this, `~/.claude/agents` is the live copy and the source of truth. Edits in `~/Documents/agents` do nothing until you copy again, and the README there should say so.
- [ ] **Step 2:** Start a new Claude session and run `/agents`. Expected: 16 agents, each with its model. Check that the model IDs load: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `haiku`. If an ID is wrong, `/agents` shows it. Fix it in the copy.
- [ ] **Step 3: Routing smoke test.** Ask "where is the partner credential resolved?" in a Leap repo. Expected: Claude delegates to `codebase-scout` (Haiku), and the result comes back as a short list of paths.
- [ ] **Step 4:** Check the README's claim that `git commit` and `git push` are blocked by hookify rules. The writing agents stage and stop because of this rule. If the rule is not active on this machine, the agents' "cannot commit" text is only a convention.
- [ ] **Step 5:** Use the fleet for a few days before Part 3. Then we have a baseline to compare the external agents against.

## Part 2 design decisions (core and limit handoff)

- **The checkpoint happens before the limit.** At the limit, Claude cannot write. So the default thresholds are 85% for the 5-hour window and 95% for the 7-day window. Both are settings.
- **Claude writes the handoff as its reply, not as a file.** The `Stop` hook reads `last_assistant_message`, finds the marker line `<!-- relay -->` and saves the text to `${CLAUDE_PLUGIN_DATA}/handoffs/<session_id>.md`. This avoids file-permission prompts, and nothing gets into the repo. Codex gets the path. The Codex sandbox can read files outside the workspace.
- **Default mode is "confirm".** Herdr opens a pane that shows the handoff and asks: `[Enter]` start Codex, `[a]` start and always auto-start from now on, `[q]` cancel. `[a]` writes `switch_mode = "auto"` to `pluginConfigs`, so the choice shows in `/config` and you can undo it there. There is one source of truth.
- **Three modes:** `confirm` (default), `auto`, `notify`. `notify` is also the automatic fallback when Claude does not run inside Herdr, or when a Herdr command fails. It shows the exact command to run.
- **Status line = sensor, hooks = decisions.** The status line process does not get the plugin options, so it only records raw usage. The hooks compare usage with the thresholds.
- **One stable launcher: `${CLAUDE_PLUGIN_DATA}/bin/relay`.** The plugin root path changes on each update, but two callers outside the plugin need a path that does not change: the `statusLine` command in `settings.json`, and the proxy agent files in `~/.claude/agents` (Part 3). The launcher is a 10-line shell script. It reads `${CLAUDE_PLUGIN_DATA}/plugin_root` and runs `python3 <root>/scripts/cli.py "$@"`. `SessionStart` writes the current root to that file each session, so a plugin update takes effect in the next session. `cli.py` has the subcommands `statusline` and `delegate`. So the status line can import the package, and there is no second copy of the file format code. If `plugin_root` is missing, `relay statusline` prints an empty line and exits 0.
- **Existing status lines keep working.** Setup saves the old `statusLine.command` to `chain.json`. Our script records usage, then runs the old command with the same input and prints its output.
- **One handoff per limit window.** The session state stores `reset_after` (the latest `resets_at` of the windows that caused the handoff). After that time, the state goes back to normal.
- **Subagents are ignored.** Hook input with `agent_id` comes from a subagent. We skip it, the same way the Herdr Claude integration does.
- **Codex writes a report when it finishes.** The Codex prompt asks for a report file (What I did, What is left, How I verified, Watch out for) at `${CLAUDE_PLUGIN_DATA}/handoffs/<session_id>.report.md`. The gate starts Codex with `--add-dir <data>/handoffs`, so the Codex sandbox can write there and nothing goes into the repo. We use a file and not the Codex screen, because `herdr agent read` cannot get back text that has scrolled off an alternate screen.
- **A background watcher does the hand-back.** The dispatcher starts `watcher.py` as a detached process (`start_new_session=True`), one per handoff, with its PID in the session state. Every 15 s it polls `herdr agent get <codex pane>`:
  - no agent yet: you have not confirmed yet, so it waits
  - `working`: it waits
  - `blocked`: it notifies you one time
  - `done` or `idle` after it saw `working`: Codex finished
  - pane gone, or 24 h with no agent (you cancelled with `[q]`): it exits
  When Codex finishes, it notifies you ("Codex finished"). Then it sleeps until `reset_after` plus 60 s. Then it checks the Claude pane. If Claude is `idle` or `done`, it sends `herdr agent prompt <claude pane> "Codex finished the delegated work. Read <report>, review git diff, then continue."`. If you already went back to Claude (`working`), or the pane has no Claude now, it only notifies you. We never type into a busy agent.
- **No report is not a failure.** If Codex stops without a report (for example, Codex hit its own limit), the watcher still hands back. It tells Claude that there is no report and to rebuild the state from `git diff`.
- **Hand-back is a setting:** `hand_back` (boolean, default `true`). When it is `false`, the watcher only saves the report and notifies you.
- **Why a polling watcher.** Claude Code has no hook that runs when another program finishes. The Codex `Stop` hook lives in the user's Codex config, which a Claude plugin should not edit. Herdr already knows the Codex state, so polling Herdr is the least invasive way. The cost is one sleeping Python process for each handoff. If the machine restarts, the watcher is gone, but the report file and the handoff stay on disk and the README says how to hand back by hand.
- **Not in v1:** triggers based on context size. Claude compacts the context itself, so a full context is not a reason to switch.

## How it flows

```
 Claude Code (main pane)                      plugin data folder              Herdr
 -----------------------                      ------------------              -----
 each response ─> status line script ───────> usage/<session>.json
                  (then runs your old status line, if there was one)

 after each tool batch ─> "PostToolBatch" hook
        reads usage + state; usage >= threshold and state normal?
        yes -> tells Claude: "finish the smallest safe step,
               reply with a handoff, then stop"  ─> state: warned

 end of turn ─> "Stop" hook
        state normal and over threshold -> block, same instruction -> warned
        state warned, reply has the handoff marker
            -> save handoffs/<session>.md ──────────────────────────> open pane beside Claude
                                                                      rename it "codex-handoff"
                                                                      run the confirm screen
            -> state: handed off                                      notification
        state warned, no marker, first time  -> block again (reminder)
        state warned, no marker, second time -> build a handoff from the
                                                transcript -> hand off

 turn fails with rate_limit ─> "StopFailure" hook
        not handed off yet -> build a handoff from the transcript -> hand off

 confirm screen (in the new pane)
        [Enter] -> start Codex with "read <handoff path> and continue"
        [a]     -> save switch_mode=auto in settings, then start Codex
        [q]     -> exit, keep the handoff file

 background watcher (started by the dispatcher)
        polls the Codex pane state every 15 s
        Codex done ──> notification "Codex finished" (report saved)
        sleep until Claude's limit window resets
        Claude pane idle? ──> tell Claude: "read <report>, review git diff, continue"
        Claude busy or gone ──> notification only
```

Hand-back sequence:

```
 Claude pane            watcher                 Codex pane              you
 -----------            -------                 ----------              ---
 handoff written ─────> started (detached)
                        poll: no agent yet  ... confirm screen <─────── [Enter]
                        poll: working       ... Codex works
                        poll: done          <── report.md written
                        notify ───────────────────────────────────────> "Codex finished"
                        sleep until reset_after
 idle <──────────────── agent prompt: "read report, review diff, continue"
 Claude continues
```

Session state machine:

```
            over threshold                 handoff sent
  normal ─────────────────────> warned ─────────────────────> handed off
    ^                                                              |
    └──────────── now >= reset_after (limit window reset) ─────────┘
```

## Repository and file structure

A new repo at `~/personal/relay`, with the same layout as `~/personal/sessions-plugin` (its own `marketplace.json`, plugin at the root). Plugin ID: `relay@relay`.

```
relay/
  .claude-plugin/plugin.json        manifest + userConfig
  .claude-plugin/marketplace.json   single-plugin marketplace
  hooks/hooks.json                  SessionStart, PostToolBatch, Stop, StopFailure
  commands/setup.md                 /relay:setup           (status line + launcher)
  commands/external.md              /relay:external        (Part 3: list, sync, pin <agent> claude|opencode|auto)
  templates/launcher.sh             source of ${CLAUDE_PLUGIN_DATA}/bin/relay
  templates/proxy-agent.md          Part 3: proxy subagent template
  scripts/
    cli.py                          launcher target: `statusline`, `delegate` subcommands
    on_session_start.py             writes plugin_root, installs the launcher, reminds about setup
    on_tool_batch.py                PostToolBatch entry point
    on_stop.py                      Stop entry point
    on_stop_failure.py              StopFailure entry point
    gate.py                         confirm screen in the Codex pane, then starts Codex
    watcher.py                      background hand-back loop (thin: polls, sleeps, calls watch.py)
    setup_statusline.py             run by /relay:setup
    external_agents.py              Part 3: run by /relay:external
    relay/
      __init__.py
      usage.py                      read usage snapshot, find windows over threshold
      statusline.py                 record usage, render or chain the status line
      state.py                      per-session phase store
      decide.py                     pure decision functions (the state machine)
      handoff.py                    instruction text, marker, save, transcript fallback, Codex prompt
      settings.py                   atomic edits to ~/.claude/settings.json
      herdr.py                      Herdr CLI adapter (shared by handoff and delegation)
      hook_io.py                    read hook input, read plugin options from env
      dispatch.py                   save the handoff, open Herdr (or fall back to notify), start the watcher
      watch.py                      pure watcher decisions: Codex progress, hand-back target
      agentdef.py                   Part 3: parse and write agent Markdown frontmatter
      delegate.py                   Part 3: run an OpenCode agent in a reused pane or headless
  tests/
    fixtures/transcript.jsonl  fixtures/codebase-scout.md
    test_usage.py  test_state.py  test_decide.py  test_handoff.py  test_settings.py
    test_herdr.py  test_dispatch.py  test_statusline.py  test_gate.py  test_watch.py
    test_agentdef.py  test_delegate.py  test_external_agents.py
  README.md
  plans/v1-<name>.md                copy of this plan (plus the Obsidian mirror)
```

Each entry script stays thin: it reads the input, calls `decide`, then does the side effects. All logic that can go wrong is in `relay/` and has unit tests.

Run all tests with: `PYTHONPATH=scripts python3 -m unittest discover -s tests -v`

---

## Chunk 1: Repo and pure logic

### Task 0: Create the repo and the worktree

**Files:**
- Create: `~/personal/relay/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.gitignore`, `README.md` (one line for now)

- [ ] **Step 1:** Run `mkdir -p ~/personal/relay && cd ~/personal/relay && git init -b main`.
- [ ] **Step 2:** Write `marketplace.json`:

```json
{
  "name": "relay",
  "owner": { "name": "Isuru Ranaweera" },
  "plugins": [
    {
      "name": "relay",
      "source": "./",
      "description": "Hand work from Claude Code to Codex in Herdr before Claude hits its usage limit"
    }
  ]
}
```

- [ ] **Step 3:** Write `plugin.json` with the `userConfig` settings:

```json
{
  "name": "relay",
  "description": "Hand work from Claude Code to Codex in Herdr before Claude hits its usage limit",
  "author": { "name": "Isuru Ranaweera" },
  "version": "0.1.0",
  "userConfig": {
    "switch_mode": {
      "type": "string",
      "title": "Switch mode",
      "description": "confirm: open Codex and wait for you. auto: start Codex at once. notify: only save the handoff and tell you.",
      "options": ["confirm", "auto", "notify"],
      "default": "confirm"
    },
    "five_hour_threshold": {
      "type": "number",
      "title": "5-hour limit threshold (%)",
      "description": "Start the handoff when 5-hour usage reaches this percentage",
      "default": 85, "min": 50, "max": 99
    },
    "seven_day_threshold": {
      "type": "number",
      "title": "7-day limit threshold (%)",
      "description": "Start the handoff when 7-day usage reaches this percentage",
      "default": 95, "min": 50, "max": 99
    },
    "codex_placement": {
      "type": "string",
      "title": "Codex placement",
      "description": "split: a pane beside Claude. tab: a new tab in the same workspace.",
      "options": ["split", "tab"],
      "default": "split"
    },
    "codex_args": {
      "type": "string",
      "title": "Extra Codex arguments",
      "description": "Added before the prompt, for example: --sandbox workspace-write",
      "default": ""
    },
    "hand_back": {
      "type": "boolean",
      "title": "Hand back to Claude",
      "description": "When Codex finishes and Claude's limit has reset, tell Claude to read the Codex report and continue. Off: only notify.",
      "default": true
    }
  }
}
```

- [ ] **Step 4:** `.gitignore`: `__pycache__/`, `.ruff_cache/`. Commit: `git add -A && git commit -m "chore: scaffold relay plugin"`.
- [ ] **Step 5:** Per the worktree rule, do the feature work in `~/.worktrees/relay/v1-plugin`: `git worktree add ~/.worktrees/relay/v1-plugin -b v1-plugin`. The repo has no remote yet, so we branch from local `main`. All later tasks run in the worktree.

### Task 1: `usage.py`: read the snapshot and find the windows over the threshold

**Files:** Create `scripts/relay/__init__.py` (empty), `scripts/relay/usage.py`. Test: `tests/test_usage.py`.

- [ ] **Step 1: Write the failing tests**

```python
import json, tempfile, unittest
from pathlib import Path
from relay.usage import Thresholds, read_snapshot, windows_over_threshold

NOW = 1_000_000

class UsageTest(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp())

    def write(self, payload):
        (self.data / "usage").mkdir(exist_ok=True)
        (self.data / "usage" / "s1.json").write_text(json.dumps(payload))

    def test_reports_each_window_at_or_over_its_threshold(self):
        self.write({"five_hour": {"used_percentage": 85, "resets_at": NOW + 60},
                    "seven_day": {"used_percentage": 40, "resets_at": NOW + 60}})
        over = windows_over_threshold(read_snapshot(self.data, "s1"), Thresholds(85, 95), NOW)
        self.assertEqual([w.name for w in over], ["five_hour"])

    def test_ignores_a_window_that_already_reset(self):
        self.write({"five_hour": {"used_percentage": 99, "resets_at": NOW - 1}})
        self.assertEqual(windows_over_threshold(read_snapshot(self.data, "s1"), Thresholds(85, 95), NOW), [])

    def test_missing_or_broken_file_means_no_snapshot(self):
        self.assertIsNone(read_snapshot(self.data, "absent"))
        (self.data / "usage").mkdir()
        (self.data / "usage" / "s1.json").write_text("{not json")
        self.assertIsNone(read_snapshot(self.data, "s1"))
```

- [ ] **Step 2:** Run `PYTHONPATH=scripts python3 -m unittest tests.test_usage -v`. Expected: FAIL with `ModuleNotFoundError`.
- [ ] **Step 3: Implement**

```python
"""Reads the rate-limit snapshot that statusline.py writes for each session.

The file format is a contract with scripts/statusline.py:
{"five_hour": {"used_percentage": 42.0, "resets_at": 1760000000},
 "seven_day": {...}, "updated_at": 1759990000}
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

WINDOW_NAMES = ("five_hour", "seven_day")


@dataclass(frozen=True)
class Window:
    name: str
    used_percentage: float
    resets_at: int  # Unix epoch seconds


@dataclass(frozen=True)
class Thresholds:
    five_hour: float
    seven_day: float

    def for_window(self, name: str) -> float:
        return getattr(self, name)


def usage_path(data_dir: Path, session_id: str) -> Path:
    return data_dir / "usage" / f"{session_id}.json"


def read_snapshot(data_dir: Path, session_id: str) -> Optional[list[Window]]:
    """Returns the windows in the snapshot, or None when no usable snapshot exists."""
    try:
        raw = json.loads(usage_path(data_dir, session_id).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    windows = [_parse_window(name, raw.get(name)) for name in WINDOW_NAMES]
    return [w for w in windows if w is not None]


def _parse_window(name: str, raw: object) -> Optional[Window]:
    if not isinstance(raw, dict):
        return None
    pct, resets_at = raw.get("used_percentage"), raw.get("resets_at")
    if not isinstance(pct, (int, float)) or not isinstance(resets_at, (int, float)):
        return None
    return Window(name, float(pct), int(resets_at))


def windows_over_threshold(snapshot: Optional[list[Window]], thresholds: Thresholds, now: int) -> list[Window]:
    """Windows that have not reset yet and are at or above their threshold."""
    if not snapshot:
        return []
    return [w for w in snapshot if w.resets_at > now and w.used_percentage >= thresholds.for_window(w.name)]
```

- [ ] **Step 4:** Run the tests again. Expected: 3 PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat: read usage snapshot and detect windows over threshold"`

### Task 2: `state.py`: session phase store

**Files:** Create `scripts/relay/state.py`. Test: `tests/test_state.py`.

- [ ] **Step 1: Failing tests.** Test 1: after `save` of `SessionState(Phase.HANDED_OFF, reset_after=NOW+60)`, `load(data, "s1", NOW)` gives the same state. Test 2: `load(data, "s1", NOW+60)` gives `SessionState()` (phase NORMAL), because the limit window reset. Test 3: a missing file gives `SessionState()`.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3: Implement**

```python
"""Per-session handoff phase, stored in the plugin data folder."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path


class Phase(str, Enum):
    NORMAL = "normal"
    WARNED = "warned"          # Claude was told to write a handoff
    HANDED_OFF = "handed_off"  # the handoff went to Codex (or to the user in notify mode)


@dataclass(frozen=True)
class SessionState:
    phase: Phase = Phase.NORMAL
    reset_after: int = 0  # epoch seconds; after this, all windows that caused the handoff have reset


def _path(data_dir: Path, session_id: str) -> Path:
    return data_dir / "state" / f"{session_id}.json"


def load(data_dir: Path, session_id: str, now: int) -> SessionState:
    try:
        raw = json.loads(_path(data_dir, session_id).read_text())
        state = SessionState(Phase(raw["phase"]), int(raw["reset_after"]))
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
        return SessionState()
    if state.phase is not Phase.NORMAL and now >= state.reset_after:
        return SessionState()
    return state


def save(data_dir: Path, session_id: str, state: SessionState) -> None:
    write_json_atomic(_path(data_dir, session_id), {**asdict(state), "phase": state.phase.value})


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)
```

`write_json_atomic` is the one atomic-write helper. `settings.py` and `handoff.py` reuse it.

- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: store per-session handoff phase`.

### Task 3: `decide.py`: the state machine as pure functions

**Files:** Create `scripts/relay/decide.py`. Test: `tests/test_decide.py`.

- [ ] **Step 1: Failing tests.** One test for each transition:
  - `test_tool_batch_warns_once`: NORMAL + over → `Action.INJECT_INSTRUCTION`, next WARNED. Then WARNED + over → `Action.NONE`.
  - `test_stop_under_threshold_does_nothing`: NORMAL + no windows over → NONE, NORMAL.
  - `test_stop_over_threshold_blocks_with_instruction`: NORMAL + over → `BLOCK_STOP`, WARNED.
  - `test_stop_with_handoff_marker_hands_off_claude_summary`: WARNED + reply has handoff → `HAND_OFF_SUMMARY`, HANDED_OFF.
  - `test_stop_without_marker_reminds_once_then_falls_back`: WARNED, no handoff, `stop_hook_active=False` → BLOCK_STOP. The same with `stop_hook_active=True` → `HAND_OFF_TRANSCRIPT`, HANDED_OFF.
  - `test_handed_off_session_is_left_alone`: HANDED_OFF + over → NONE for all three events.
  - `test_rate_limit_failure_falls_back_to_transcript`: NORMAL or WARNED + `error="rate_limit"` → HAND_OFF_TRANSCRIPT. `error="overloaded"` → NONE.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3: Implement**

```python
"""Decides what each hook should do. No I/O, so every transition has a unit test."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .state import Phase


class Action(str, Enum):
    NONE = "none"
    INJECT_INSTRUCTION = "inject_instruction"    # PostToolBatch additionalContext
    BLOCK_STOP = "block_stop"                    # Stop decision=block with the instruction
    HAND_OFF_SUMMARY = "hand_off_summary"        # use the handoff Claude wrote
    HAND_OFF_TRANSCRIPT = "hand_off_transcript"  # Claude could not write one; build it from the transcript


@dataclass(frozen=True)
class Decision:
    action: Action
    next_phase: Phase


def on_tool_batch(phase: Phase, over_threshold: bool) -> Decision:
    if phase is Phase.NORMAL and over_threshold:
        return Decision(Action.INJECT_INSTRUCTION, Phase.WARNED)
    return Decision(Action.NONE, phase)


def on_stop(phase: Phase, over_threshold: bool, reply_has_handoff: bool, stop_hook_active: bool) -> Decision:
    if phase is Phase.HANDED_OFF:
        return Decision(Action.NONE, phase)
    if phase is Phase.NORMAL:
        if over_threshold:
            return Decision(Action.BLOCK_STOP, Phase.WARNED)
        return Decision(Action.NONE, phase)
    # phase is WARNED
    if reply_has_handoff:
        return Decision(Action.HAND_OFF_SUMMARY, Phase.HANDED_OFF)
    if not stop_hook_active:
        return Decision(Action.BLOCK_STOP, Phase.WARNED)
    return Decision(Action.HAND_OFF_TRANSCRIPT, Phase.HANDED_OFF)


def on_stop_failure(phase: Phase, error: str) -> Decision:
    if error == "rate_limit" and phase is not Phase.HANDED_OFF:
        return Decision(Action.HAND_OFF_TRANSCRIPT, Phase.HANDED_OFF)
    return Decision(Action.NONE, phase)
```

A WARNED session that is under the threshold again does not happen here: `state.load` resets the phase when `reset_after` passes.

- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: handoff state machine`.

### Task 4: `handoff.py`: instruction, marker, save, fallback, Codex prompt

**Files:** Create `scripts/relay/handoff.py`, `tests/fixtures/transcript.jsonl`. Test: `tests/test_handoff.py`.

- [ ] **Step 1: Fixture.** Write a 5-line JSONL transcript: a user message with string content ("Add rate limiting to the pipeline API"), an assistant message, a user entry that holds only a `tool_result` block, a user message with a `text` block list ("Also cover the 429 path"), and an assistant message.
- [ ] **Step 2: Failing tests.**
  - `test_extract_returns_text_after_marker`: `extract("intro\n<!-- relay -->\n## Goal\nX")` == `"## Goal\nX"`, and `contains_handoff` is True. For a reply without the marker, it is False.
  - `test_recent_user_prompts_skips_tool_results`: the fixture gives `["Add rate limiting to the pipeline API", "Also cover the 429 path"]`.
  - `test_fallback_names_transcript_and_git_state`: the text contains the transcript path, both prompts and the given git status string.
  - `test_instruction_names_window_and_percentage`: `instruction([Window("five_hour", 87.0, 0)])` contains `"5-hour"`, `"87%"` and the marker line.
- [ ] **Step 3: Implement.** Main parts:

```python
MARKER = "<!-- relay -->"
WINDOW_LABELS = {"five_hour": "5-hour", "seven_day": "7-day"}


def instruction(over: list[Window]) -> str:
    usage = ", ".join(f"{WINDOW_LABELS[w.name]} usage is at {w.used_percentage:.0f}%" for w in over)
    return (
        f"relay: your {usage}, above the handoff threshold. "
        "Finish only the smallest safe step you are in. Do not start new work. "
        "Then reply with a handoff for Codex, another coding agent that has none of your context. "
        f"Start the reply with this exact line:\n{MARKER}\n"
        "Then write these sections: Goal, Done, In progress, Next steps (numbered and concrete), "
        "Files touched, How to verify, Watch out for. After the handoff, stop."
    )


def contains_handoff(reply: str | None) -> bool:
    return MARKER in (reply or "")


def extract(reply: str) -> str:
    return reply.split(MARKER, 1)[1].strip()


def save(data_dir: Path, session_id: str, text: str) -> Path:
    path = data_dir / "handoffs" / f"{session_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n")
    return path


def recent_user_prompts(transcript_path: Path, limit: int = 3) -> list[str]:
    """Text the user typed, newest last. Tool results also have type "user", so we skip them."""
    ...  # read JSONL. Keep entries with type == "user" whose message.content is a str
         # or has "text" blocks. Skip bad lines. Return the last `limit` items.


def git_status(cwd: Path) -> str:
    """`git status --short` plus the last commit line, or a note when cwd is not a git repo."""
    ...  # subprocess.run with a 5 s timeout. On failure return "(not a git repository)".


def fallback(transcript_path: Path, prompts: list[str], status: str) -> str:
    """Handoff for when Claude hit the limit before it wrote one."""
    ...  # Markdown: say that Claude stopped without a handoff, give the transcript path
         # ("read the last part of this JSONL file"), the recent prompts, the git status,
         # and "check `git diff` first".


def report_path(handoff_path: Path) -> Path:
    return handoff_path.with_suffix(".report.md")


def codex_prompt(handoff_path: Path, cwd: Path) -> str:
    return (
        f"You are taking over work from Claude Code, which reached its usage limit. "
        f"First read the handoff file at {handoff_path}. The project is {cwd}. "
        "Follow the project AGENTS.md. Continue from 'Next steps'. Check `git diff` before you change anything. "
        f"When you finish, or when you cannot continue, write a report to {report_path(handoff_path)} "
        "with these sections: What I did, What is left, How I verified, Watch out for. "
        "Claude Code reads this report when it takes the work back."
    )


def hand_back_prompt(report: Path, report_exists: bool) -> str:
    if report_exists:
        return (f"relay: Codex finished the work you handed off. Read its report at {report}, "
                "review `git diff`, then continue the task.")
    return ("relay: Codex stopped without writing a report. "
            "Review `git diff` and `git log` to find what changed since your handoff, then continue the task.")
```

Add `test_codex_prompt_asks_for_report_at_report_path` and `test_hand_back_prompt_without_report_points_to_git_diff`.

- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: handoff instruction, capture, and transcript fallback`.

### Task 5: `settings.py`: safe edits to `~/.claude/settings.json`

**Files:** Create `scripts/relay/settings.py`. Test: `tests/test_settings.py`.

- [ ] **Step 1: Failing tests** (on a temp settings file):
  - `test_set_plugin_option_keeps_other_settings`: a file with `hooks` and another plugin's `pluginConfigs` keeps both after `set_plugin_option(path, "relay@relay", "switch_mode", "auto")`, and the new value is at `pluginConfigs[id].options.switch_mode`.
  - `test_install_statusline_returns_previous_and_is_idempotent`: the first call returns the old `{"type": "command", "command": "old.sh"}`. A second call with the same command returns `None` and does not change the file.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `load_settings(path) -> dict` (a missing file gives `{}`), `set_plugin_option(path, plugin_id, key, value)` and `install_statusline(path, command) -> Optional[dict]`. The last one returns the replaced `statusLine`, or `None` when ours is already there or when none existed. Both write with `state.write_json_atomic`. `PLUGIN_ID = "relay@relay"` and `SETTINGS_PATH = Path.home() / ".claude" / "settings.json"` are constants here.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: atomic settings.json edits`.

---

## Chunk 2: Side effects and the status line

### Task 6: `herdr.py`: Herdr adapter

**Files:** Create `scripts/relay/herdr.py`. Test: `tests/test_herdr.py`.

All Herdr calls go through a `Runner` (`Callable[[list[str]], str]` that returns stdout). The tests pass a fake runner that records the commands and returns sample JSON.

- [ ] **Step 1: Failing tests.**
  - `test_context_is_none_outside_herdr`: `context_from_env({})` is `None`. `{"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_WORKSPACE_ID": "w1"}` gives a context.
  - `test_split_opens_pane_beside_claude`: `open_codex_pane(ctx, "split", cwd, run)` calls `["herdr", "pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", cwd, "--no-focus"]` and returns the pane ID from `.result.pane.pane_id`.
  - `test_tab_opens_new_tab_in_same_workspace`: it calls `herdr tab create --workspace w1 --cwd <cwd> --label codex-handoff --no-focus` and reads `.result.root_pane.pane_id`. We saw this shape in a live call earlier.
  - `test_launch_gate_renames_then_runs`: it calls `herdr pane rename <id> codex-handoff`, then `herdr pane run <id> "<shlex-joined gate command>"`.
- [ ] **Step 2:** See them fail.
  - `test_agent_status_reads_state_or_none`: `agent_status("w1:p2", run)` calls `herdr agent get w1:p2` and returns `"working"` from `.result.agent.agent_status`. When the runner raises (no agent in the pane), it returns `AgentStatus.NO_AGENT`. When the pane does not exist (check the error code in the stderr JSON during implementation), it returns `AgentStatus.PANE_GONE`. The three results mean different things, so we do not use `None` for all of them.
  - `test_prompt_agent_sends_text`: `prompt_agent("w1:p1", text, run)` calls `herdr agent prompt w1:p1 <text>` (no `--wait`).
- [ ] **Step 3: Implement** `HerdrContext(pane_id, workspace_id)`, `context_from_env(env)`, `open_codex_pane(ctx, placement, cwd, run) -> str`, `launch_gate(pane_id, gate_cmd, run)`, `notify(title, body, run)` (`herdr notification show <title> --body <body> --sound request`), `agent_status(pane_id, run) -> AgentStatus | str`, `prompt_agent(pane_id, text, run)`, and `subprocess_runner(args) -> str` (`subprocess.run(check=True, capture_output=True, text=True, timeout=10)`). Callers catch `HerdrError`. Wrap `CalledProcessError`, `TimeoutExpired`, `FileNotFoundError`, `KeyError` and `json.JSONDecodeError` in `HerdrError`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: herdr adapter`.

### Task 7: `statusline.py`: the sensor, and the launcher

**Files:** Create `scripts/relay/statusline.py`, `scripts/cli.py`, `templates/launcher.sh`. Test: `tests/test_statusline.py`.

`launcher.sh` (installed as `${CLAUDE_PLUGIN_DATA}/bin/relay` with the data path filled in):

```sh
#!/bin/sh
# relay launcher. Stable path for the status line and proxy agents. Managed by the relay plugin.
DATA_DIR="__RELAY_DATA_DIR__"
ROOT="$(cat "$DATA_DIR/plugin_root" 2>/dev/null)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/scripts/cli.py" ]; then
  [ "${1:-}" = "statusline" ] && { echo; exit 0; }
  echo "relay: plugin not found. Start a new Claude Code session so the plugin can register itself." >&2
  exit 1
fi
RELAY_DATA_DIR="$DATA_DIR" exec python3 "$ROOT/scripts/cli.py" "$@"
```

`cli.py` sends `statusline` to `relay.statusline.main(stdin, data_dir)` and `delegate` to `relay.delegate.main(argv, ...)` (Task 17). It reads the data folder from `RELAY_DATA_DIR`.

- [ ] **Step 1: Failing tests.**
  - `test_recorded_usage_is_readable_by_hooks`: this is the **contract test**. Give `record_usage` a payload with `session_id` and `rate_limits`. `usage.read_snapshot` must read the result with the same numbers. It keeps the two sides of the file format in step.
  - `test_no_rate_limits_writes_nothing`: an API-key user gets no `rate_limits`, so no file is written and the hooks do nothing.
  - `test_chained_status_line_output_passes_through`: with `chain.json` = `{"command": "echo previous"}`, `render(raw, data_dir)` returns `"previous\n"`.
  - `test_default_line_without_chain`: it returns `"5h 42% | 7d 61% | ctx 23%"` for a sample payload, and it leaves out the parts it has no data for.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.** `main(stdin, data_dir)` reads stdin once, calls `record_usage(payload, data_dir)` (writes `usage/<session_id>.json` with `state.write_json_atomic`, and the path comes from `usage.usage_path`, so both sides share one definition), then prints `render(raw, data_dir)`. `render` runs the chained command with `shell=True, input=raw, timeout=5` when `chain.json` exists. Otherwise it builds the default line. A bad or empty input still prints a line and never raises, because a crash would blank the status line.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: status line usage sensor`.

### Task 8: `hook_io.py` and `dispatch.py`

**Files:** Create `scripts/relay/hook_io.py`, `scripts/relay/dispatch.py`. Test: `tests/test_dispatch.py`.

- [ ] **Step 1: Failing tests** (a fake runner, a temp data folder):
  - `test_notify_mode_saves_handoff_and_never_calls_herdr`: the message contains the handoff path and a copy-paste `codex` command, and the runner has no calls.
  - `test_outside_herdr_falls_back_to_notify`: switch mode is `confirm`, but no Herdr env, so we get the same notify message.
  - `test_herdr_failure_falls_back_to_notify`: the runner raises `HerdrError` on `pane split`. The result is the notify message and no exception.
  - `test_confirm_mode_opens_pane_and_starts_gate_in_confirm_mode`: the gate command has `--mode confirm`, the handoff path, the cwd and `--codex-args`.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.**
  - `hook_io.py`: `read_hook_input(stdin) -> dict`, `is_subagent(hook_input) -> bool`, and `Options.from_env(env)`. `Options` has `switch_mode`, `thresholds: Thresholds`, `placement` and `codex_args`. It parses the `CLAUDE_PLUGIN_OPTION_*` strings and uses the manifest defaults when a value is missing. It also has `data_dir_from_env(env) -> Path` (from `CLAUDE_PLUGIN_DATA`).
  - `dispatch.py`: `hand_off(text, session_id, cwd, options, data_dir, env, run, plugin_root, reset_after, spawn) -> str`. It saves the handoff (`handoff.save`). For `notify` mode, or when there is no Herdr context, it returns `manual_message(path, cwd)`. Otherwise it opens the pane, runs `launch_gate` with `[sys.executable, <plugin_root>/scripts/gate.py, --handoff, path, --cwd, cwd, --mode, mode, --codex-args, args]`, and sends a notification ("Claude is near its limit", "Codex is ready in pane codex-handoff"). Then it starts the watcher through `spawn` (by default `subprocess.Popen([...watcher.py, --codex-pane, id, --claude-pane, ctx.pane_id, --report, report_path, --reset-after, N, --hand-back, 0|1, --data-dir, dir], start_new_session=True, stdin/stdout/stderr=DEVNULL)`) and returns a short message. It catches `HerdrError` and returns the manual message.
  - Add `test_herdr_handoff_starts_watcher_with_both_panes`: the fake `spawn` gets the Codex pane, the Claude pane, the report path and `reset_after`. Also add `test_notify_mode_starts_no_watcher`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: hand off to herdr with notify fallback`.

### Task 9: `gate.py`: the confirm screen

**Files:** Create `scripts/gate.py`. Test: `tests/test_gate.py`.

- [ ] **Step 1: Failing tests** (inject `input_fn` and `exec_fn`, use a temp settings path):
  - `test_enter_starts_codex_with_handoff_prompt`: `exec_fn` gets `("codex", ["codex", "--sandbox", "workspace-write", <codex_prompt>])`.
  - `test_a_saves_auto_mode_then_starts_codex`: the settings file then has `switch_mode == "auto"` for `relay@relay`, and `exec_fn` was called.
  - `test_q_cancels_without_starting_codex`: `exec_fn` was not called, and the output names the saved handoff path.
  - `test_auto_mode_never_prompts`: `input_fn` raises if it is called, and `exec_fn` was called.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `main(argv, input_fn=input, exec_fn=os.execvp, settings_path=SETTINGS_PATH) -> int`. Parse the arguments. Print a header and the first 40 lines of the handoff. In confirm mode, ask `[Enter] start Codex   [a] start and always auto-start   [q] cancel`. Then `os.chdir(cwd)` and `exec_fn("codex", ["codex", "--add-dir", str(handoff_path.parent), *shlex.split(codex_args), codex_prompt(path, cwd)])`. `--add-dir` lets Codex write the report into the handoffs folder. Update the Step 1 test to expect it. `exec` replaces the gate with Codex, so Herdr sees Codex as the foreground program in the pane and shows it in the sidebar.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat: confirm screen that launches codex`.

### Task 9b: `watch.py` and `watcher.py`: hand the work back to Claude

**Files:** Create `scripts/relay/watch.py`, `scripts/watcher.py`. Test: `tests/test_watch.py`.

We keep the decisions pure in `watch.py`. `watcher.py` only polls, sleeps and runs Herdr commands.

- [ ] **Step 1: Failing tests.**
  - `test_codex_progress_waits_until_it_saw_working_then_done`: `next_progress(WAITING_TO_START, "no_agent")` stays `WAITING_TO_START`. `"working"` goes to `RUNNING`. `RUNNING` + `"done"` goes to `FINISHED`. `RUNNING` + `"idle"` goes to `FINISHED`. `WAITING_TO_START` + `"idle"` stays `WAITING_TO_START`, because Codex at its first prompt is idle before it starts work.
  - `test_blocked_is_reported_once`: `RUNNING` + `"blocked"` gives `(RUNNING, notify_blocked=True)` the first time, and `False` while it stays blocked.
  - `test_pane_gone_or_start_timeout_abandons`: `"pane_gone"` goes to `ABANDONED` from any state. `WAITING_TO_START` for longer than 24 h goes to `ABANDONED`.
  - `test_hand_back_target`: `hand_back_action(hand_back=True, claude_status="idle")` gives `PROMPT_CLAUDE`, and `"done"` gives the same. `"working"`, `"blocked"`, `"no_agent"` and `"pane_gone"` give `NOTIFY_ONLY`. `hand_back=False` always gives `NOTIFY_ONLY`.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement `watch.py`**

```python
"""Pure decisions for the hand-back watcher."""
from __future__ import annotations

from enum import Enum

START_TIMEOUT_SECONDS = 24 * 3600


class CodexProgress(str, Enum):
    WAITING_TO_START = "waiting_to_start"  # confirm screen, or Codex at its first prompt
    RUNNING = "running"
    FINISHED = "finished"
    ABANDONED = "abandoned"                # pane closed, or never started


class HandBack(str, Enum):
    PROMPT_CLAUDE = "prompt_claude"
    NOTIFY_ONLY = "notify_only"


READY_FOR_INPUT = {"idle", "done"}


def next_progress(progress: CodexProgress, status: str, waited_seconds: int = 0,
                  was_blocked: bool = False) -> tuple[CodexProgress, bool]:
    """Returns the new progress and whether to notify the user that Codex is blocked."""
    if status == "pane_gone":
        return CodexProgress.ABANDONED, False
    if progress is CodexProgress.WAITING_TO_START:
        if status in ("working", "blocked"):
            return CodexProgress.RUNNING, status == "blocked"
        if waited_seconds > START_TIMEOUT_SECONDS:
            return CodexProgress.ABANDONED, False
        return progress, False
    if progress is CodexProgress.RUNNING:
        if status in READY_FOR_INPUT:
            return CodexProgress.FINISHED, False
        return progress, status == "blocked" and not was_blocked
    return progress, False


def hand_back_action(hand_back: bool, claude_status: str) -> HandBack:
    if hand_back and claude_status in READY_FOR_INPUT:
        return HandBack.PROMPT_CLAUDE
    return HandBack.NOTIFY_ONLY
```

- [ ] **Step 4: Implement `watcher.py`.** Parse the arguments. Loop: `status = herdr.agent_status(codex_pane)`, call `next_progress`, notify when it says blocked, and `time.sleep(15)` until `FINISHED` or `ABANDONED`. On `ABANDONED`, exit quietly. On `FINISHED`, notify "Codex finished" with the report path, or with "no report" when the file is missing. Sleep until `reset_after + 60`, one sleep per 10 minutes so a clock change after the Mac wakes is handled. Then call `hand_back_action(hand_back, herdr.agent_status(claude_pane))`. For `PROMPT_CLAUDE`, run `herdr.prompt_agent(claude_pane, handoff.hand_back_prompt(report, report.exists()))`. Otherwise notify "Codex finished. Claude was busy, so read <report> when you go back". Log all errors to `data_dir/errors.log` and exit 0.
- [ ] **Step 5:** Tests pass. Commit `feat: watcher hands work back to claude`.

---

## Chunk 3: Wiring, setup, verification

### Task 10: Hook entry scripts and `hooks/hooks.json`

**Files:** Create `scripts/on_tool_batch.py`, `scripts/on_stop.py`, `scripts/on_stop_failure.py`, `hooks/hooks.json`.

Each entry script does these steps: read the input, exit 0 for subagents, load options, snapshot and state, call the `decide` function, save the new state (with `reset_after` = the latest `resets_at` of the windows over the threshold), do the side effect, then print the hook JSON. Any exception is caught and written to `data_dir/errors.log`, and the script exits 0. A broken plugin must never block Claude.

- `on_tool_batch.py`: for `INJECT_INSTRUCTION`, print `{"hookSpecificOutput": {"hookEventName": "PostToolBatch", "additionalContext": instruction(over)}}`.
- `on_stop.py`: for `BLOCK_STOP`, print `{"decision": "block", "reason": instruction(over)}`. For `HAND_OFF_SUMMARY`, use `extract(last_assistant_message)`. For `HAND_OFF_TRANSCRIPT`, use `fallback(...)`. Both then call `dispatch.hand_off` and print `{"systemMessage": message}`.
- `on_stop_failure.py`: for `HAND_OFF_TRANSCRIPT`, call `dispatch.hand_off`. Output is ignored here, so the Herdr notification tells the user. Outside Herdr, print `terminalSequence` with an OSC 9 desktop notification. Check the allowed format in the "Emit terminal notifications" section of the hooks docs first.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/on_session_start.py\"", "timeout": 10 }] }],
    "PostToolBatch": [{ "hooks": [{ "type": "command", "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/on_tool_batch.py\"", "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/on_stop.py\"", "timeout": 30 }] }],
    "StopFailure": [{ "matcher": "rate_limit", "hooks": [{ "type": "command", "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/on_stop_failure.py\"", "timeout": 30 }] }]
  }
}
```

- [ ] **Step 1:** Write the scripts and `hooks.json`.
- [ ] **Step 2: Smoke test by pipe.** Put a usage file at 90%, then pipe a fake `PostToolBatch` payload into `on_tool_batch.py` with `CLAUDE_PLUGIN_DATA=<tmp>`. Expected: `additionalContext` JSON. Run it again. Expected: no output (already warned). Pipe a `Stop` payload that has the marker in `last_assistant_message`, without Herdr env. Expected: `systemMessage` with the manual command, and `handoffs/<session>.md` exists.
- [ ] **Step 3:** Commit `feat: wire hooks`.

### Task 11: Setup command and `SessionStart` refresh

**Files:** Create `commands/setup.md`, `scripts/setup_statusline.py`, `scripts/on_session_start.py`.

- `setup.md` tells Claude to run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/setup_statusline.py" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"` (both variables are replaced in command content) and to report the result. It also says that the script changes `statusLine` in `~/.claude/settings.json` and keeps any existing status line.
- `relay/launcher.py` (a small shared module): `install_launcher(plugin_root, data_dir) -> Path` writes `plugin_root` and renders `templates/launcher.sh` to `<data>/bin/relay` (mode 755). It rewrites the launcher only when the content changed.
- `setup_statusline.py`: run `install_launcher`, then `install_statusline(SETTINGS_PATH, "'<data>/bin/relay' statusline")`. When it returns an old command, write that command to `chain.json`. Print what changed.
- `on_session_start.py`: always run `install_launcher(CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA)`, so the launcher points at the current plugin version. If `statusLine` in settings is not ours, print `{"systemMessage": "relay: run /relay:setup to connect the status line"}`.
- Test in `tests/test_statusline.py`: `test_install_launcher_points_at_current_root_and_is_idempotent`. After a second call with a new root, `plugin_root` has the new path, and the launcher file is unchanged.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** Run `setup_statusline.py` against a temp `HOME`, so the real settings file is not touched. Check `statusLine`, `chain.json` and `bin/relay`. Pipe a sample status line JSON into `bin/relay statusline` and check that the output line and the usage file are correct. Run setup again and check that nothing changes.
- [ ] **Step 3:** Commit `feat: setup command for status line`.

### Task 12: README

- [ ] Write `README.md`: what the plugin does (with the flow diagram), what it needs (Claude Pro/Max for `rate_limits`, Herdr, Codex), install (`/plugin marketplace add IsuruDR/claude-relay`, then `/plugin install relay@relay`, then `/relay:setup`), the settings table, the three modes, and how to undo the status line change. Commit `docs: readme`.

### Task 13: Lint, tests, review

- [ ] Run `PYTHONPATH=scripts python3 -m unittest discover -s tests -v`. Expected: all tests pass.
- [ ] Run `/usr/bin/python3 -m compileall -q scripts`. This proves that the code works on macOS Python 3.9.
- [ ] Run `uvx ruff check . && uvx ruff format --check .`. Fix everything it finds.
- [ ] Run `claude plugin validate .` (check the exact command with `claude plugin --help`). Expected: the manifest and hooks are valid.
- [ ] Run a code review with superpowers:requesting-code-review against `git diff main --stat`. Iterate once, and list any issues that are still open.

### Task 14: End-to-end check in Herdr

- [ ] Install from the local path: `claude plugin marketplace add ~/.worktrees/relay/v1-plugin`, then `claude plugin install relay@relay`, then run `/relay:setup` in a Claude session in a Herdr pane.
- [ ] Check that the status line shows `5h N% | 7d N% | ctx N%`, and that `~/.claude/plugins/data/<id>/usage/<session>.json` exists.
- [ ] In `/config`, set the 5-hour threshold to the minimum (50) or just under your current usage. Give Claude a task with several tool calls. Expected: in the middle of the turn, Claude says it got the limit instruction, finishes the step, and replies with the marker handoff. A `codex-handoff` pane opens beside it with the confirm screen, and a Herdr notification shows.
- [ ] Push `[a]`. Expected: Codex starts, reads the handoff and continues. `pluginConfigs["relay@relay"].options.switch_mode` is `"auto"`, and `/config` shows it.
- [ ] Check the backup path: pipe a `StopFailure` `rate_limit` payload into `on_stop_failure.py` in a Herdr pane. Expected: a pane with the transcript-based handoff.
- [ ] **Hand-back:** for the test, run the watcher by hand with `--reset-after <now + 120>`, so we do not wait for a real reset. Give Codex a small task. Expected: `<session>.report.md` exists when Codex finishes, then a "Codex finished" notification shows. About 3 minutes later, the Claude pane gets the hand-back prompt, reads the report and continues.
- [ ] **Hand-back, busy Claude:** do it again, and type something into Claude before the reset time. Expected: notification only, and no text is typed into Claude.
- [ ] Set the thresholds back to 85/95 and `switch_mode` back to `confirm`.

---
---

### After approval (repo rules)

- Split this document into one plan per feature, as brainstorming asks: `~/personal/relay/plans/v1-<name>.md` (Part 1 and Part 2: fleet, core, limit handoff) and `v2-<name>.md` (Part 3: external delegation). Mirror both to `~/Documents/obsidian/brainstorm/brainstorm/personal/relay/plans/`, with the ASCII diagrams turned into Mermaid.
- Build order: Part 1 now (config only). Part 2 (Tasks 0-14) next. Part 3 (Tasks 15-19) after Part 2 is merged, because it reuses the launcher, `herdr.py` and `settings.py`. The README task gets a Part 3 section (the three cheap-model settings, `list`, `sync`, `pin`, and the MCP limit) when Part 3 lands.
- Do not push to GitHub or publish the marketplace without asking first.

## Watch out for

- **Only Pro/Max users get `rate_limits`.** API-key users get no usage file, so the plugin does nothing. The README says this.
- **The status line refreshes only on events.** A turn that makes one huge model call without tool calls can go past the threshold before any hook runs. The 85% default leaves room for this. The `StopFailure` backup covers the rest.
- **Two agents, one working tree.** Codex works in the same folder that Claude left. That is safe because Claude is stopped by then. If you type into Claude again before the limit resets, both agents can edit the same files.
- **Codex approval prompts** stop Codex, and Herdr shows it as `blocked`. With `codex_args`, you can choose a looser sandbox if you trust the repo.
- **`[a]` changes a user setting from a script.** It edits only the one documented key, with an atomic write. Other settings are kept.
- **The watcher is lost if the machine restarts.** The handoff and report files stay in the data folder. The README says how to hand back by hand: tell Claude "read <report> and continue".
- **Hand-back uses Claude's new budget.** It sends one prompt after the reset, which is the point. If you do not want that, turn off `hand_back`.
- **Codex idle vs finished.** Codex is `idle` at its first prompt and again when it finishes. The watcher counts it as finished only after it saw `working`. If Codex asks a question and waits (`blocked`), you get a notification. The watcher does not answer for you.
