# relay v5: Agent Fleet, Limit Handoff (TypeScript, Herdr-managed agents)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

This replaces `v3-quiet-lighthouse.md`. The runtime is the same: Node with TypeScript types and no runtime dependencies. What changed: Herdr now manages the Codex agent (`herdr agent start`, `agent prompt --wait`, `agent wait`), so the watcher lost its own polling state machine. Every pane and agent we create gets a `relay-` name. External delegation is in `v6-patient-courier.md`.

**Goal:** Claude Code stays the one main agent and sends each piece of work to the cheapest agent that can do it well. When Claude gets close to its usage limit, it hands the work to Codex and takes it back after the reset. Every agent reports back to the Claude main agent.

**Architecture:** There are three parts, built in this order:

1. **Turn on the agent fleet.** This is config only (done on 2026-09-26): the 16 agents in `~/Documents/agents/*.md` are copied to `~/.claude/agents/`. Claude Code routes by each agent's `description`, and subagent results go back to the main agent.
2. **The `relay` plugin core and the limit handoff** (this plan). A shared Herdr core runs an external agent in a pane and gets a report back. The first feature uses it for the limit handoff to Codex, and for the hand-back.
3. **External delegation** (`v6-patient-courier.md`). It reuses the same core.

**Tech Stack:** Node 22.18+ running `.ts` files directly (built-in type stripping, no build step), `node:test` and `node:assert`, the Claude Code plugin system (hooks, `userConfig`, commands), the Herdr CLI and the Codex CLI. No runtime dependencies. Dev checks run through `npx` with pinned versions: `tsc --noEmit` for types, and Biome for lint and format.

**Commits:** hookify rules on this machine block the git commit and push commands. Each "Commit" step means: stage the changes and write down the commit message for the user.

---

## Context

You use Claude Code as your main agent, Codex as the second one, and OpenCode with OpenRouter (personal) or Vercel AI Gateway (work) for cheap models. Your transcript analysis in `~/Documents/agents/00-README.md` shows that 96% of the tokens are cache reads, and that the median turn re-reads 242K tokens. So the biggest saving is to move work into agents with a small context. A cheaper model gives more savings on top.

When Claude reaches its usage limit, the work stops until the window resets. We want Claude to see the limit coming, write down where it is, and give the work to Codex, so the work continues. Herdr makes the switch possible: it can open a pane, start Codex in it, and show you both agents in the sidebar.

```
 your prompt
     │
 Claude Code main agent ── picks an agent by its description (native routing)
     │
     ├── Claude-model agent (brainstorm-partner, plan-writer, implementer, ...)
     │        native subagent ─────────────────────────────> result back to main
     │
     ├── external agent (codebase-scout, log-digger)                [v6]
     │        tiny proxy subagent (Haiku, Bash only, small context)
     │        runs the relay delegate command
     │           └── `opencode run --agent <name> -m <cheap model>`
     │               in the reused Herdr pane "relay-<name>", output saved to a report
     │        proxy returns the report ────────────────────> result back to main
     │
     └── near the usage limit (automatic, not routed)               [this plan]
              Claude writes a handoff -> Codex in a Herdr pane
              Codex report -> hand back to Claude after the reset
```

We checked the facts in the current docs (Claude Code 2.1.282, Codex 0.157, Herdr 0.9.0, Node 22 docs):

- The status line JSON has `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`. It shows only for Pro/Max subscriptions. Hooks do not get these values.
- A plugin **cannot** set the main status line. It can set only `agent` and `subagentStatusLine`. So we need a one-time `/relay:setup` command.
- `PostToolBatch` can return `additionalContext`, which Claude reads before its next model call. This is how we warn Claude in the middle of a long turn.
- `Stop` can return `decision: "block"` with a `reason`, and it gets `last_assistant_message` and `stop_hook_active`. Claude Code limits this to 8 blocks in a row.
- `StopFailure` gets `error: "rate_limit"`. It ignores output except `terminalSequence`, so it can only run side effects.
- `userConfig` gives us settings that users pick at install time and can change in `/config`. Hooks read them as `CLAUDE_PLUGIN_OPTION_<KEY>`. Stored values go to `pluginConfigs["<plugin>@<marketplace>"].options` in `~/.claude/settings.json`.
- `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) stays the same across plugin updates. `${CLAUDE_PLUGIN_ROOT}` changes with each version.
- Node runs `.ts` files with type stripping, on by default from v22.18.0. It does not check types, and it rejects syntax that needs code generation: `enum`, parameter properties, namespaces with runtime code. Imports need file extensions, and `"type": "module"` makes the files ES modules. Node does not read `tsconfig.json`.

## Part 1: Turn on the agent fleet (done)

- [x] **Step 1:** Copied the 16 agents to `~/.claude/agents/` (not a symlink, as you asked). `~/.claude/agents` is now the live copy and the source of truth. Edits in `~/Documents/agents` do nothing until you copy again.
- [x] **Step 2:** Checked the model IDs with one headless call each: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5` and `haiku` all work.
- [x] **Step 4:** The hookify rules `~/.claude/hookify.block-git-commit.local.md` and `hookify.block-git-push.local.md` are active. So the "cannot commit" text in the agents is enforced.
- [ ] **Step 3: Routing smoke test** (needs a new session). Ask "where is the partner credential resolved?" in a Leap repo. Expected: Claude delegates to `codebase-scout` (Haiku), and the result comes back as a short list of paths.
- [ ] **Step 5:** Use the fleet for a few days before v6. Then we have a baseline to compare the external agents against.

## Part 2 design decisions (core and limit handoff)

- **Runtime: Node 22.18+ with `.ts` files, no build and no dependencies.** Plugins run from their folder, so we have no install step. Type stripping lets us write TypeScript with no compile step. Node 20 is end-of-life, so 22.18 is a fair minimum. Because stripping has limits, the code uses `as const` objects with union types and not `enum`, and plain classes or functions and not parameter properties. `import type` is used for types only.
- **One small JavaScript guard: `scripts/run.mjs`.** Every hook, the launcher and the pane commands start through `node --no-warnings run.mjs <entry> ...`. It checks `process.versions.node >= 22.18.0`. When the version is lower, the `session-start` entry prints `{"systemMessage": "relay needs Node 22.18 or later"}`, and every other entry exits 0 quietly. When the version is correct, it imports `scripts/entries/<entry>.ts`. The guard must be plain JS, because an old Node cannot parse a `.ts` file at all. `--no-warnings` stops the stripping warning on stderr.
- **The checkpoint happens before the limit.** At the limit, Claude cannot write. So the default thresholds are 85% for the 5-hour window and 95% for the 7-day window. Both are settings.
- **Claude writes the handoff as its reply, not as a file.** The `Stop` hook reads `last_assistant_message`, finds the marker line `<!-- relay-handoff -->` and saves the text to `${CLAUDE_PLUGIN_DATA}/handoffs/<session_id>.md`. This avoids file-permission prompts, and nothing gets into the repo. Codex gets the path.
- **Default mode is "confirm".** Herdr opens a pane that shows the handoff and asks: `[Enter]` start Codex, `[a]` start and always auto-start from now on, `[q]` cancel. `[a]` writes `switch_mode = "auto"` to `pluginConfigs`, so the choice shows in `/config` and you can undo it there. There is one source of truth.
- **Herdr starts and tracks Codex.** We use the Herdr agent commands, not our own process handling:
  - `herdr agent start relay-codex --kind codex --pane <id> -- --add-dir <handoffs> <codex_args>` starts Codex under a name, and returns only when Codex is ready for input.
  - `herdr agent prompt relay-codex "<codex prompt>" --wait` sends the task and waits until Codex settles (`done`, `idle` or `blocked`).
  - `herdr agent wait relay-codex --until done --until idle` waits again after a `blocked` question.
  `agent start` needs the pane at a shell prompt, so the confirm screen must exit first. The gate prints a result line and exits. The background runner (the old "watcher") waits for that line with `herdr pane wait-output`, then starts Codex. `codex_args` is split into separate arguments with a small quote-aware splitter, and never goes through a shell.
- **Every pane and agent we create has a `relay-` name.** Names follow Herdr's rule `[a-z][a-z0-9_-]{0,31}`, and a live agent name must be unique, so a second one at the same time gets `-2`, `-3`, and so on.

  ```
  what                        pane label             Herdr agent name
  ----                        ----------             ----------------
  Codex for the handoff       relay-codex            relay-codex
  delegated OpenCode agent    relay-codebase-scout   (none, see v6)
  your Claude main agent      (not changed)          its own name, or relay-claude if it has none
  ```

  We name your Claude agent only when it has no name. This is not only for looks: Herdr gives a pane a new ID when you move it to another workspace, but a name follows the agent. So the hand-back finds Claude even if you move its pane while Codex works. Herdr clears the name when Claude exits, and then the hand-back falls back to a notification.
- **Result markers never appear as-is in a command.** `herdr pane wait-output` also searches the command line on the screen. A command that contains the literal marker would match itself at once. So markers are printed with `printf` from parts (`printf 'RELAY_%s:%s:%s\n' GATE <id> start`), and a test checks that the command text does not contain the full marker.
- **Three modes:** `confirm` (default), `auto`, `notify`. `notify` is also the automatic fallback when Claude does not run inside Herdr, or when a Herdr command fails. It shows the exact command to run.
- **Status line = sensor, hooks = decisions.** The status line process does not get the plugin options, so it only records raw usage. The hooks compare usage with the thresholds.
- **One stable launcher: `${CLAUDE_PLUGIN_DATA}/bin/relay`.** The plugin root path changes on each update, but two callers outside the plugin need a path that does not change: the `statusLine` command in `settings.json`, and the proxy agent files in `~/.claude/agents` (v6). The launcher is a short shell script. It reads `${CLAUDE_PLUGIN_DATA}/plugin_root` and runs `node --no-warnings <root>/scripts/run.mjs "$@"`. `SessionStart` writes the current root to that file each session, so a plugin update takes effect in the next session. If `plugin_root` is missing, `relay statusline` prints an empty line and exits 0.
- **Existing status lines keep working.** Setup saves the old `statusLine.command` to `chain.json`. Our status line records usage, then runs the old command with the same input and prints its output.
- **One handoff per limit window.** The session state stores `resetAfter` (the latest `resets_at` of the windows that caused the handoff). After that time, the state goes back to normal.
- **Subagents are ignored.** Hook input with `agent_id` comes from a subagent. We skip it, the same way the Herdr Claude integration does.
- **Codex writes a report when it finishes.** The Codex prompt asks for a report file (What I did, What is left, How I verified, Watch out for) at `${CLAUDE_PLUGIN_DATA}/handoffs/<session_id>.report.md`. Codex starts with `--add-dir <data>/handoffs`, so the Codex sandbox can write there and nothing goes into the repo. We use a file and not the Codex screen, because `herdr agent read` cannot get back text that has scrolled off an alternate screen.
- **A background runner does the Codex part and the hand-back.** The dispatcher starts it with `spawn(process.execPath, [...], { detached: true, stdio: "ignore" }).unref()`, one per handoff. It runs these steps, and each wait is a Herdr command:
  1. In confirm mode, `herdr pane wait-output <codex pane id> --regex 'RELAY_GATE:<id>:(start|cancel)' --timeout 86400000`. On `cancel` or a timeout, it exits, and the handoff file stays.
  2. `herdr agent start relay-codex ...`, then `herdr agent prompt relay-codex "<codex prompt>" --wait`.
  3. While the result is `blocked`: notify you one time ("Codex needs your answer"), then `herdr agent wait relay-codex --until done --until idle`. The runner never answers for you.
  4. Notify you ("Codex finished", with the report path, or "no report" when the file is missing).
  5. Sleep until `resetAfter` plus 60 s.
  6. `herdr agent get <claude name>`. If Claude is `idle` or `done`, send `herdr agent prompt <claude name> "<hand-back prompt>"`. If you already went back to Claude (`working`), or the name is gone, only notify you. We never type into a busy agent.
  `agent prompt --wait` can return `agent_prompt_stalled` when Codex shows no activity within 5 s. Then the runner reads `agent get` one time. If Codex is `working`, it goes on to step 3's wait. Otherwise it notifies you and exits. We never send the prompt a second time without checking, because the first one may have arrived.
- **No report is not a failure.** If Codex stops without a report (for example, Codex hit its own limit), the runner still hands back. It tells Claude that there is no report and to rebuild the state from `git diff`.
- **Hand-back is a setting:** `hand_back` (boolean, default `true`). When it is `false`, the runner only saves the report and notifies you.
- **Why a background runner.** Claude Code has no hook that runs when another program finishes. The Codex `Stop` hook lives in the user's Codex config, which a Claude plugin should not edit. Herdr already knows the Codex state and can block until it changes, so waiting on Herdr commands is the least invasive way. The cost is one sleeping Node process for each handoff. If the machine restarts, the runner is gone, but the report file and the handoff stay on disk, and the README says how to hand back by hand.
- **Not in this plan:** triggers based on context size. Claude compacts the context itself, so a full context is not a reason to switch.

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
                                                                      label it "relay-codex"
                                                                      name Claude "relay-claude"
                                                                        (only if it has no name)
                                                                      run the confirm screen
            -> state: handed off                                      notification
        state warned, no marker, first time  -> block again (reminder)
        state warned, no marker, second time -> build a handoff from the
                                                transcript -> hand off

 turn fails with rate_limit ─> "StopFailure" hook
        not handed off yet -> build a handoff from the transcript -> hand off

 confirm screen (in the new pane; prints a result line, then exits to the shell)
        [Enter] -> RELAY_GATE:<id>:start
        [a]     -> save switch_mode=auto in settings, then RELAY_GATE:<id>:start
        [q]     -> RELAY_GATE:<id>:cancel (the handoff file stays)

 background runner (started by the dispatcher; every wait is a Herdr command)
        herdr pane wait-output  ──> result line "start"  (skipped in auto mode)
        herdr agent start relay-codex --kind codex
        herdr agent prompt relay-codex "<read the handoff and continue>" --wait
        blocked? ──> notify you, then herdr agent wait relay-codex --until done --until idle
        Codex done ──> notification "Codex finished" (report saved)
        sleep until Claude's limit window resets
        herdr agent get relay-claude: idle? ──> herdr agent prompt relay-claude "read <report>, continue"
        Claude busy or gone ──> notification only
```

Hand-back sequence:

```
 Claude (relay-claude)  runner                  relay-codex pane        you
 ---------------------  ------                  ----------------        ---
 handoff written ─────> started (detached)
                        pane wait-output ...... confirm screen <─────── [Enter]
                                           <─── RELAY_GATE:<id>:start
                        agent start ──────────> Codex ready
                        agent prompt --wait ──> Codex works
                                           <─── done, report.md written
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

The repo is `~/personal/relay` (already created with `git init`), with the same layout as `~/personal/sessions-plugin`: its own `marketplace.json`, and the plugin at the root. Plugin ID: `relay@relay`.

```
relay/
  package.json                      "type": "module", "engines": {"node": ">=22.18"}, scripts only
  tsconfig.json                     type checking only (noEmit, erasableSyntaxOnly)
  biome.json                        lint + format settings
  .claude-plugin/plugin.json        manifest + userConfig
  .claude-plugin/marketplace.json   single-plugin marketplace
  hooks/hooks.json                  SessionStart, PostToolBatch, Stop, StopFailure
  commands/setup.md                 /relay:setup (status line + launcher)
  templates/launcher.sh             source of ${CLAUDE_PLUGIN_DATA}/bin/relay
  scripts/
    run.mjs                         plain-JS guard: checks the Node version, imports the entry
    version.mjs                     plain-JS version compare used by the guard
    entries/                        thin entry points, one per hook or command
      session-start.ts              writes plugin_root, installs the launcher, reminds about setup
      tool-batch.ts                 PostToolBatch
      stop.ts                       Stop
      stop-failure.ts               StopFailure
      statusline.ts                 status line (called through the launcher)
      gate.ts                       confirm screen in the Codex pane
      runner.ts                     background runner: starts Codex through Herdr, hands back
      setup.ts                      run by /relay:setup
    lib/
      usage.ts                      read usage snapshot, find windows over threshold
      statusline.ts                 record usage, render or chain the status line
      state.ts                      per-session phase store, atomic JSON write
      decide.ts                     pure decision functions (the state machine)
      handoff.ts                    instruction, marker, save, transcript fallback, prompts
      settings.ts                   atomic edits to ~/.claude/settings.json
      herdr.ts                      Herdr CLI adapter (shared with v6)
      hook-io.ts                    read hook input, read plugin options from env
      dispatch.ts                   save the handoff, open Herdr or fall back, start the runner
      names.ts                      relay- names: free label/agent name with -2, -3 suffixes
      handback.ts                   pure hand-back decision, Codex outcome handling
      launcher.ts                   install the launcher, write plugin_root
  tests/
    fixtures/transcript.jsonl
    usage.test.ts  state.test.ts  decide.test.ts  handoff.test.ts  settings.test.ts
    herdr.test.ts  dispatch.test.ts  statusline.test.ts  gate.test.ts  names.test.ts  handback.test.ts
  README.md
  plans/                            v1-v6 plans (the Obsidian vault has mirrors)
```

Each entry stays thin: it reads the input, calls `decide`, then does the side effects. All logic that can go wrong is in `scripts/lib/` and has unit tests. Side effects come in through small injected functions (`run` for Herdr commands, `spawn` for the runner, `readLine` for the confirm prompt), so tests pass fakes and never start real programs.

Commands (in `package.json` scripts):

- `npm test`: `node --no-warnings --test tests/`
- `npm run typecheck`: `npx -y -p typescript@5.9 tsc --noEmit`
- `npm run lint`: `npx -y @biomejs/biome@2 check .`
- `npm run format`: `npx -y @biomejs/biome@2 format --write .`

---

## Chunk 1: Repo and pure logic

### Task 0: Scaffold the repo and the worktree

**Files:** Create `package.json`, `tsconfig.json`, `biome.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.gitignore`, `README.md` (one line for now), `scripts/run.mjs`.

- [ ] **Step 1:** `package.json`:

```json
{
  "name": "relay",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "test": "node --no-warnings --test tests/",
    "typecheck": "npx -y -p typescript@5.9 tsc --noEmit",
    "lint": "npx -y @biomejs/biome@2 check .",
    "format": "npx -y @biomejs/biome@2 format --write ."
  }
}
```

- [ ] **Step 2:** `tsconfig.json` (Node ignores it; `tsc` uses it for checks only):

```json
{
  "compilerOptions": {
    "noEmit": true,
    "target": "esnext",
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "types": ["node"]
  },
  "include": ["scripts/**/*.ts", "tests/**/*.ts"]
}
```

`types: ["node"]` needs `@types/node`. We do not add it as a dependency. The typecheck script adds it for the run: `npx -y -p typescript@5.9 -p @types/node@22 tsc --noEmit`. Update the script in Step 1 to that.

- [ ] **Step 3:** `marketplace.json` and `plugin.json`. The `userConfig` fields are `switch_mode` (`confirm` / `auto` / `notify`, default `confirm`), `five_hour_threshold` (number, default 85, 50-99), `seven_day_threshold` (number, default 95, 50-99), `codex_placement` (`split` / `tab`, default `split`), `codex_args` (string, default empty) and `hand_back` (boolean, default true). Each field has a `title` and a `description` in plain words. The v1 plan has the full JSON, and it is the same here.
- [ ] **Step 4:** `scripts/run.mjs`:

```js
// scripts/version.mjs: plain JavaScript, imported by run.mjs before any .ts file loads.
/** True when version `current` ([major, minor, patch]) is older than `minimum`. */
export function isOlderThan(current, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] !== minimum[i]) return current[i] < minimum[i];
  }
  return false;
}
```

```js
// scripts/run.mjs: relay entry guard. Plain JavaScript on purpose: an old Node cannot parse .ts files.
// Usage: node --no-warnings run.mjs <entry> [args...]
import { isOlderThan } from "./version.mjs";

const MINIMUM_NODE = [22, 18, 0];
const [entry, ...args] = process.argv.slice(2);
const currentNode = process.versions.node.split(".").map(Number);

if (isOlderThan(currentNode, MINIMUM_NODE)) {
  if (entry === "session-start") {
    process.stdout.write(JSON.stringify({ systemMessage: `relay needs Node 22.18 or later (found ${process.versions.node}).` }));
  }
  process.exit(0);
}

const { main } = await import(new URL(`./entries/${entry}.ts`, import.meta.url));
process.exitCode = await main(args);
```

Add `tests/version.test.ts`: `isOlderThan([22, 17, 9], [22, 18, 0])` is true, and `[22, 18, 0]`, `[23, 0, 0]` and `[25, 4, 0]` are false. An unknown entry name makes `import` throw, which is a programming error, so it is fine for it to fail loudly.
- [ ] **Step 5:** `.gitignore`: `node_modules/`. Stage all files. Commit message: `chore: scaffold relay plugin`.
- [ ] **Step 6:** Per the worktree rule, do the feature work in `~/.worktrees/relay/v5-core`: `git worktree add ~/.worktrees/relay/v5-core -b v5-core`. The repo has no remote yet, so we branch from local `main`. The user must first make the scaffold commit, because a worktree needs a commit to branch from.

### Task 1: `usage.ts`: read the snapshot and find the windows over the threshold

**Files:** Create `scripts/lib/usage.ts`. Test: `tests/usage.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, windowsOverThreshold } from "../scripts/lib/usage.ts";

const NOW = 1_000_000;
const thresholds = { five_hour: 85, seven_day: 95 };

function dataDirWith(payload: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  mkdirSync(join(dir, "usage"));
  writeFileSync(join(dir, "usage", "s1.json"), payload);
  return dir;
}

test("reports each window at or over its threshold", () => {
  const dir = dataDirWith(JSON.stringify({
    five_hour: { used_percentage: 85, resets_at: NOW + 60 },
    seven_day: { used_percentage: 40, resets_at: NOW + 60 },
  }));
  const over = windowsOverThreshold(readSnapshot(dir, "s1"), thresholds, NOW);
  assert.deepEqual(over.map((w) => w.name), ["five_hour"]);
});

test("ignores a window that already reset", () => {
  const dir = dataDirWith(JSON.stringify({ five_hour: { used_percentage: 99, resets_at: NOW - 1 } }));
  assert.deepEqual(windowsOverThreshold(readSnapshot(dir, "s1"), thresholds, NOW), []);
});

test("missing or broken file means no snapshot", () => {
  assert.equal(readSnapshot(mkdtempSync(join(tmpdir(), "relay-")), "absent"), undefined);
  assert.equal(readSnapshot(dataDirWith("{not json"), "s1"), undefined);
});
```

- [ ] **Step 2:** Run `node --no-warnings --test tests/usage.test.ts`. Expected: FAIL, because the module does not exist.
- [ ] **Step 3: Implement**

```ts
// Reads the rate-limit snapshot that the status line writes for each session.
// File format (shared with lib/statusline.ts through usagePath and UsageWindow):
// {"five_hour": {"used_percentage": 42, "resets_at": 1760000000}, "seven_day": {...}, "updated_at": 1759990000}
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOW_NAMES = ["five_hour", "seven_day"] as const;
export type WindowName = (typeof WINDOW_NAMES)[number];

export interface UsageWindow {
  name: WindowName;
  usedPercentage: number;
  resetsAt: number; // Unix epoch seconds
}

export type Thresholds = Record<WindowName, number>;

export function usagePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "usage", `${sessionId}.json`);
}

/** The windows in the snapshot, or undefined when no usable snapshot exists. */
export function readSnapshot(dataDir: string, sessionId: string): UsageWindow[] | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(usagePath(dataDir, sessionId), "utf8"));
  } catch {
    return undefined;
  }
  return WINDOW_NAMES.map((name) => parseWindow(name, raw[name])).filter((w) => w !== undefined);
}

function parseWindow(name: WindowName, value: unknown): UsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { used_percentage: pct, resets_at: resetsAt } = value as Record<string, unknown>;
  if (typeof pct !== "number" || typeof resetsAt !== "number") return undefined;
  return { name, usedPercentage: pct, resetsAt };
}

/** Windows that have not reset yet and are at or above their threshold. */
export function windowsOverThreshold(snapshot: UsageWindow[] | undefined, thresholds: Thresholds, now: number): UsageWindow[] {
  return (snapshot ?? []).filter((w) => w.resetsAt > now && w.usedPercentage >= thresholds[w.name]);
}
```

- [ ] **Step 4:** Run the tests again. Expected: 3 pass.
- [ ] **Step 5:** Stage. Commit message: `feat: read usage snapshot and detect windows over threshold`.

### Task 2: `state.ts`: session phase store

**Files:** Create `scripts/lib/state.ts`. Test: `tests/state.test.ts`.

- [ ] **Step 1: Failing tests.** Test 1: after `saveState(dir, "s1", { phase: "handed_off", resetAfter: NOW + 60 })`, `loadState(dir, "s1", NOW)` gives the same state. Test 2: `loadState(dir, "s1", NOW + 60)` gives `{ phase: "normal", resetAfter: 0 }`, because the limit window reset. Test 3: a missing file gives the normal state. Test 4: `writeJsonAtomic` leaves no `.tmp` file after it writes.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3: Implement**

```ts
// Per-session handoff phase, stored in the plugin data folder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const Phase = {
  Normal: "normal",
  Warned: "warned",        // Claude was told to write a handoff
  HandedOff: "handed_off", // the handoff went to Codex (or to the user in notify mode)
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface SessionState {
  phase: Phase;
  resetAfter: number; // epoch seconds; after this, all windows that caused the handoff have reset
}

export const NORMAL_STATE: SessionState = { phase: Phase.Normal, resetAfter: 0 };

function statePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "state", `${sessionId}.json`);
}

export function loadState(dataDir: string, sessionId: string, now: number): SessionState {
  let state: SessionState;
  try {
    state = JSON.parse(readFileSync(statePath(dataDir, sessionId), "utf8"));
  } catch {
    return NORMAL_STATE;
  }
  if (!Object.values(Phase).includes(state.phase) || typeof state.resetAfter !== "number") return NORMAL_STATE;
  if (state.phase !== Phase.Normal && now >= state.resetAfter) return NORMAL_STATE;
  return state;
}

export function saveState(dataDir: string, sessionId: string, state: SessionState): void {
  writeJsonAtomic(statePath(dataDir, sessionId), state);
}

/** The one atomic JSON write helper. settings.ts, statusline.ts and handoff.ts reuse it. */
export function writeJsonAtomic(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}
```

- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: store per-session handoff phase`.

### Task 3: `decide.ts`: the state machine as pure functions

**Files:** Create `scripts/lib/decide.ts`. Test: `tests/decide.test.ts`.

- [ ] **Step 1: Failing tests.** One test for each transition:
  - `tool batch warns once`: normal + over → `inject_instruction`, next warned. Then warned + over → `none`.
  - `stop under threshold does nothing`: normal + not over → `none`, normal.
  - `stop over threshold blocks with instruction`: normal + over → `block_stop`, warned.
  - `stop with handoff marker hands off Claude's summary`: warned + reply has the handoff → `hand_off_summary`, handed_off.
  - `stop without marker reminds once, then falls back`: warned, no handoff, `stopHookActive=false` → `block_stop`. The same with `stopHookActive=true` → `hand_off_transcript`, handed_off.
  - `handed-off session is left alone`: handed_off + over → `none` for all three events.
  - `rate limit failure falls back to the transcript`: normal or warned + `error="rate_limit"` → `hand_off_transcript`. `error="overloaded"` → `none`.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3: Implement**

```ts
// Decides what each hook should do. No I/O, so every transition has a unit test.
import { Phase } from "./state.ts";

export const Action = {
  None: "none",
  InjectInstruction: "inject_instruction",   // PostToolBatch additionalContext
  BlockStop: "block_stop",                   // Stop decision=block with the instruction
  HandOffSummary: "hand_off_summary",        // use the handoff Claude wrote
  HandOffTranscript: "hand_off_transcript",  // Claude could not write one; build it from the transcript
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export interface Decision {
  action: Action;
  nextPhase: Phase;
}

const stay = (phase: Phase): Decision => ({ action: Action.None, nextPhase: phase });

export function onToolBatch(phase: Phase, overThreshold: boolean): Decision {
  if (phase === Phase.Normal && overThreshold) return { action: Action.InjectInstruction, nextPhase: Phase.Warned };
  return stay(phase);
}

export function onStop(phase: Phase, overThreshold: boolean, replyHasHandoff: boolean, stopHookActive: boolean): Decision {
  if (phase === Phase.HandedOff) return stay(phase);
  if (phase === Phase.Normal) {
    return overThreshold ? { action: Action.BlockStop, nextPhase: Phase.Warned } : stay(phase);
  }
  // phase is Warned
  if (replyHasHandoff) return { action: Action.HandOffSummary, nextPhase: Phase.HandedOff };
  if (!stopHookActive) return { action: Action.BlockStop, nextPhase: Phase.Warned };
  return { action: Action.HandOffTranscript, nextPhase: Phase.HandedOff };
}

export function onStopFailure(phase: Phase, error: string): Decision {
  if (error === "rate_limit" && phase !== Phase.HandedOff) {
    return { action: Action.HandOffTranscript, nextPhase: Phase.HandedOff };
  }
  return stay(phase);
}
```

A warned session that is under the threshold again does not happen here: `loadState` resets the phase when `resetAfter` passes.

- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: handoff state machine`.

### Task 4: `handoff.ts`: instruction, marker, save, fallback, prompts

**Files:** Create `scripts/lib/handoff.ts`, `tests/fixtures/transcript.jsonl`. Test: `tests/handoff.test.ts`.

- [ ] **Step 1: Fixture.** Write a 5-line JSONL transcript: a user message with string content ("Add rate limiting to the pipeline API"), an assistant message, a user entry that holds only a `tool_result` block, a user message with a `text` block list ("Also cover the 429 path"), and an assistant message.
- [ ] **Step 2: Failing tests.**
  - `extract returns text after marker`: `extractHandoff("intro\n<!-- relay-handoff -->\n## Goal\nX")` is `"## Goal\nX"`, and `containsHandoff` is true. For a reply without the marker it is false.
  - `recent user prompts skip tool results`: the fixture gives `["Add rate limiting to the pipeline API", "Also cover the 429 path"]`.
  - `fallback names transcript and git state`: the text has the transcript path, both prompts and the given git status.
  - `instruction names window and percentage`: `instruction([{ name: "five_hour", usedPercentage: 87, resetsAt: 0 }])` has `"5-hour"`, `"87%"` and the marker line.
  - `codex prompt asks for the report at the report path`.
  - `hand-back prompt without report points to git diff`.
- [ ] **Step 3: Implement.** Main parts:

```ts
export const HANDOFF_MARKER = "<!-- relay-handoff -->";
const WINDOW_LABELS: Record<WindowName, string> = { five_hour: "5-hour", seven_day: "7-day" };

export function instruction(over: UsageWindow[]): string {
  const usage = over.map((w) => `${WINDOW_LABELS[w.name]} usage is at ${Math.round(w.usedPercentage)}%`).join(", ");
  return [
    `relay: your ${usage}, above the handoff threshold.`,
    "Finish only the smallest safe step you are in. Do not start new work.",
    "Then reply with a handoff for Codex, another coding agent that has none of your context.",
    `Start the reply with this exact line:\n${HANDOFF_MARKER}`,
    "Then write these sections: Goal, Done, In progress, Next steps (numbered and concrete),",
    "Files touched, How to verify, Watch out for. After the handoff, stop.",
  ].join("\n");
}

export const containsHandoff = (reply: string | undefined): boolean => (reply ?? "").includes(HANDOFF_MARKER);
export const extractHandoff = (reply: string): string => reply.split(HANDOFF_MARKER)[1].trim();

export function saveHandoff(dataDir: string, sessionId: string, text: string): string { /* handoffs/<id>.md */ }
export const reportPath = (handoffPath: string): string => handoffPath.replace(/\.md$/, ".report.md");

/** Text the user typed, newest last. Tool results also have type "user", so we skip them. */
export function recentUserPrompts(transcriptPath: string, limit = 3): string[] { /* read JSONL, skip bad lines */ }

/** `git status --short` plus the last commit line, or a note when cwd is not a git repo. */
export function gitStatus(cwd: string, exec = execFileSync): string { /* 5 s timeout; on failure "(not a git repository)" */ }

/** Handoff for when Claude hit the limit before it wrote one. */
export function fallbackHandoff(transcriptPath: string, prompts: string[], status: string): string { /* Markdown */ }

export function codexPrompt(handoffPath: string, cwd: string): string {
  return [
    "You are taking over work from Claude Code, which reached its usage limit.",
    `First read the handoff file at ${handoffPath}. The project is ${cwd}.`,
    "Follow the project AGENTS.md. Continue from 'Next steps'. Check `git diff` before you change anything.",
    `When you finish, or when you cannot continue, write a report to ${reportPath(handoffPath)}`,
    "with these sections: What I did, What is left, How I verified, Watch out for.",
    "Claude Code reads this report when it takes the work back.",
  ].join(" ");
}

export function handBackPrompt(report: string, reportExists: boolean): string {
  return reportExists
    ? `relay: Codex finished the work you handed off. Read its report at ${report}, review \`git diff\`, then continue the task.`
    : "relay: Codex stopped without writing a report. Review `git diff` and `git log` to find what changed since your handoff, then continue the task.";
}
```

- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: handoff instruction, capture, and transcript fallback`.

### Task 5: `settings.ts`: safe edits to `~/.claude/settings.json`

**Files:** Create `scripts/lib/settings.ts`. Test: `tests/settings.test.ts`.

- [ ] **Step 1: Failing tests** (on a temp settings file):
  - `setPluginOption keeps other settings`: a file with `hooks` and another plugin's `pluginConfigs` keeps both after `setPluginOption(path, "relay@relay", "switch_mode", "auto")`, and the new value is at `pluginConfigs["relay@relay"].options.switch_mode`.
  - `installStatusLine returns the previous one and is idempotent`: the first call returns the old `{ type: "command", command: "old.sh" }`. A second call with the same command returns `undefined` and does not change the file.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `loadSettings(path)` (a missing file gives `{}`), `setPluginOption(path, pluginId, key, value)`, `pluginOptions(path, pluginId)` (for v6) and `installStatusLine(path, command): StatusLine | undefined`. It returns the replaced `statusLine`, or `undefined` when ours is already there or when none existed. Writes use `writeJsonAtomic`. `PLUGIN_ID = "relay@relay"` and `SETTINGS_PATH = join(homedir(), ".claude", "settings.json")` are constants here.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: atomic settings.json edits`.

---

## Chunk 2: Side effects and the status line

### Task 6: `herdr.ts`: Herdr adapter

**Files:** Create `scripts/lib/herdr.ts`. Test: `tests/herdr.test.ts`.

All Herdr calls go through a `Runner`: `type Runner = (args: string[], opts?: { timeoutMs?: number }) => string` (returns stdout, throws on failure). The real one is `execFileSync("herdr", args, { encoding: "utf8", timeout: opts?.timeoutMs ?? 10_000 })`. Long waits (`agent prompt --wait`, `agent wait`, `pane wait-output`) pass `timeoutMs: 0`, which means no limit, and let Herdr's own `--timeout` decide. The tests pass a fake runner that records the commands and returns sample JSON.

- [ ] **Step 1: Failing tests.**
  - `context is undefined outside Herdr`: `herdrContext({})` is `undefined`. `{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }` gives a context.
  - `split opens a labelled pane beside Claude`: `openPane(ctx, "split", cwd, "relay-codex", run)` calls `pane split --pane w1:p1 --direction right --cwd <cwd> --no-focus`, then `pane rename <id> relay-codex`, and returns the ID from `.result.pane.pane_id`.
  - `tab opens a labelled tab in the same workspace`: it calls `tab create --workspace w1 --cwd <cwd> --label relay-codex --no-focus`, then `pane rename <id> relay-codex`, and reads `.result.root_pane.pane_id`. We saw this shape in a live call.
  - `runInPane sends the command`: `pane run <id> <command>`.
  - `agentStatus reads the state`: `agent get relay-codex` gives `"working"` from `.result.agent.agent_status`. A target with no agent gives `AgentStatus.NoAgent`, and a closed pane gives `AgentStatus.PaneGone`. Check the error codes in the stderr JSON during implementation. The three results mean different things, so they are three distinct values, not one `undefined`.
  - `agentName reads the current name`: `agentName("w1:p1", run)` returns `.result.agent.name`, or `undefined` when the agent has no name.
  - `startAgent passes the name, kind, pane and native args`: `startAgent("relay-codex", "codex", "w1:p3", ["--add-dir", "/d"], run)` calls `agent start relay-codex --kind codex --pane w1:p3 --timeout 60000 -- --add-dir /d`.
  - `promptAndWait returns the settled status`: `agent prompt relay-codex <text> --wait` with `timeoutMs: 0` returns `done`, `idle` or `blocked` from the result JSON. The error `agent_prompt_stalled` gives the distinct value `PromptOutcome.Stalled`.
  - `waitUntilFinished`: calls `agent wait relay-codex --until done --until idle` with `timeoutMs: 0`.
  - `waitForOutput uses a regex and Herdr's timeout`: `waitForOutput("w1:p3", "RELAY_GATE:ab12:(start|cancel)", 86_400_000, run)` calls `pane wait-output w1:p3 --regex <pattern> --timeout 86400000` and returns the matched text.
  - `renameAgent`: `agent rename w1:p1 relay-claude`.
  - `promptAgent sends text without waiting`: `agent prompt relay-claude <text>`.
- [ ] **Step 2:** See them fail. Before Step 3, run each command once by hand in a test pane and save the real JSON (success and error cases) as fixtures, so the tests use real shapes and not guesses.
- [ ] **Step 3: Implement** `herdrContext`, `openPane`, `runInPane`, `notify(title, body, run)` (`notification show <title> --body <body> --sound request`), `agentStatus`, `agentName`, `startAgent`, `promptAndWait`, `waitUntilFinished`, `waitForOutput`, `renameAgent`, `promptAgent` and `herdrRunner`. Wrap each failure (non-zero exit, timeout, missing binary, bad JSON, missing key) in `HerdrError` with the Herdr error code when there is one. Callers catch it.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: herdr adapter`.

### Task 6b: `names.ts`: `relay-` names

**Files:** Create `scripts/lib/names.ts`. Test: `tests/names.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `first free name`: `freeName("relay-codex", ["relay-claude"])` is `relay-codex`. `freeName("relay-codex", ["relay-codex", "relay-codex-2"])` is `relay-codex-3`.
  - `names follow Herdr's rule`: `relayName("codebase-scout")` is `relay-codebase-scout`. A long agent name is cut so the result, with room for a `-99` suffix, stays within 32 characters. Characters outside `[a-z0-9_-]` become `-`. Every result matches `^[a-z][a-z0-9_-]{0,31}$`.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `relayName(role)` and `freeName(base, taken)`. The caller gets `taken` from `herdr agent list` (agent names) or `herdr pane list` (pane labels). The live check happens right before use, so a clash is rare. If `agent start` still fails with a name clash, the runner tries the next suffix one time.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: relay naming`.

### Task 7: status line sensor and launcher

**Files:** Create `scripts/lib/statusline.ts`, `scripts/entries/statusline.ts`, `scripts/lib/launcher.ts`, `templates/launcher.sh`. Test: `tests/statusline.test.ts`.

`launcher.sh` (installed as `${CLAUDE_PLUGIN_DATA}/bin/relay`, with the data path filled in):

```sh
#!/bin/sh
# relay launcher. Stable path for the status line and proxy agents. Managed by the relay plugin.
DATA_DIR="__RELAY_DATA_DIR__"
ROOT="$(cat "$DATA_DIR/plugin_root" 2>/dev/null)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/scripts/run.mjs" ]; then
  [ "${1:-}" = "statusline" ] && { echo; exit 0; }
  echo "relay: plugin not found. Start a new Claude Code session so the plugin can register itself." >&2
  exit 1
fi
RELAY_DATA_DIR="$DATA_DIR" exec node --no-warnings "$ROOT/scripts/run.mjs" "$@"
```

- [ ] **Step 1: Failing tests.**
  - `recorded usage is readable by hooks`: this is the **contract test**. Give `recordUsage` a payload with `session_id` and `rate_limits`. `readSnapshot` must read the result with the same numbers.
  - `no rate limits writes nothing`: an API-key user gets no `rate_limits`, so no file is written and the hooks do nothing.
  - `chained status line output passes through`: with `chain.json` = `{"command": "echo previous"}`, `render(raw, dataDir)` returns `"previous\n"`.
  - `default line without chain`: it returns `"5h 42% | 7d 61% | ctx 23%"` for a sample payload, and it leaves out the parts it has no data for.
  - `installLauncher points at the current root and is idempotent`: after a second call with a new root, `plugin_root` has the new path, and the launcher file is unchanged.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.** `recordUsage(payload, dataDir)` writes `usagePath(...)` with `writeJsonAtomic`, so both sides share one definition. `render(raw, dataDir)` runs the chained command with `execSync(command, { input: raw, timeout: 5000 })` when `chain.json` exists. Otherwise it builds the default line. The entry reads stdin once, records, renders, and never throws: any error prints an empty line, because a crash would blank the status line. `installLauncher(pluginRoot, dataDir)` writes `plugin_root`, renders the template to `<data>/bin/relay` (mode 755), and rewrites the file only when the content changed.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: status line usage sensor and launcher`.

### Task 8: `hook-io.ts` and `dispatch.ts`

**Files:** Create `scripts/lib/hook-io.ts`, `scripts/lib/dispatch.ts`. Test: `tests/dispatch.test.ts`.

- [ ] **Step 1: Failing tests** (fake runner, fake spawn, temp data folder):
  - `notify mode saves the handoff and never calls Herdr`: the message has the handoff path and a copy-paste `codex` command, and the runner has no calls.
  - `outside Herdr falls back to notify`: the mode is `confirm`, but there is no Herdr env, so we get the same notify message.
  - `Herdr failure falls back to notify`: the runner throws `HerdrError` on `pane split`. The result is the notify message, and nothing throws.
  - `confirm mode opens a relay-codex pane and runs the gate`: the pane label is `relay-codex`, and the `pane run` command is `node --no-warnings <root>/scripts/run.mjs gate --id <id> --handoff <path>`. The command text does **not** contain `RELAY_GATE:<id>:`, because `pane wait-output` would match the command line itself.
  - `auto mode opens the pane and runs no gate`.
  - `an unnamed Claude gets relay-claude, a named Claude keeps its name`: when `agentName` returns `undefined`, the runner call gets `relay-claude` and `agent rename <claude pane> relay-claude` was called. When it returns `isuru-main`, no rename happens and the runner gets `isuru-main`.
  - `Herdr handoff starts the runner with names, not pane IDs`: the fake `spawn` gets the Codex pane ID (for the gate wait and `agent start`), the Codex agent name, the Claude agent name, the report path and `resetAfter`.
  - `notify mode starts no runner`.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement.**
  - `hook-io.ts`: `readHookInput(text)`, `isSubagent(input)`, `optionsFromEnv(env): Options` (parses the `CLAUDE_PLUGIN_OPTION_*` strings, with the manifest defaults when a value is missing) and `dataDirFromEnv(env)`.
  - `dispatch.ts`: `handOff({ text, sessionId, cwd, options, dataDir, env, run, spawn, pluginRoot, resetAfter }): string`. It saves the handoff and the Codex prompt (`handoffs/<id>.prompt.txt`). For `notify` mode, or with no Herdr context, it returns `manualMessage(path, cwd)`. Otherwise:
    1. Pick the Codex name with `freeName("relay-codex", …)` and open the pane with that label.
    2. Make sure Claude has a name (keep its own, or rename it to a free `relay-claude`).
    3. In confirm mode, run the gate in the pane.
    4. Notify ("Claude is near its limit", "Codex is ready in pane relay-codex").
    5. Start the runner: `spawn(process.execPath, ["--no-warnings", run.mjs, "runner", ...], { detached: true, stdio: "ignore" }).unref()`.
    It returns a short message. It catches `HerdrError` and returns the manual message.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: hand off to herdr with notify fallback`.

### Task 9: `gate.ts`: the confirm screen

**Files:** Create `scripts/entries/gate.ts`. Test: `tests/gate.test.ts`.

The gate runs only in confirm mode. It shows the handoff, asks, prints one result line, and exits, so the pane is back at a shell prompt. The runner (Task 9b) waits for the line and then starts Codex with `herdr agent start`, which needs a shell prompt.

- [ ] **Step 1: Failing tests** (inject `readLine`, `write` and the settings path):
  - `Enter prints start`: the output ends with `RELAY_GATE:<id>:start`, and the settings are unchanged.
  - `a saves auto mode and prints start`: `pluginConfigs["relay@relay"].options.switch_mode` is `"auto"`, and the output ends with `RELAY_GATE:<id>:start`.
  - `q prints cancel`: the output ends with `RELAY_GATE:<id>:cancel` and names the saved handoff path.
  - `the result line is built from parts`: the gate source code has no literal `RELAY_GATE:`. It joins `"RELAY_" + "GATE"`, so the echo of the command line and the source code can never match the runner's regex. This is a cheap guard, and it documents the reason.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement** `runGate(args, { readLine, settingsPath, write }): Promise<number>` (always exit 0). It prints a header and the first 40 lines of the handoff, then asks `[Enter] start Codex   [a] start and always auto-start   [q] cancel`. The entry's `main` passes a `readLine` built on `node:readline/promises`.
- [ ] **Step 4:** Tests pass. **Step 5:** Stage. Commit message: `feat: confirm screen`.

### Task 9b: `handback.ts` and the runner entry

**Files:** Create `scripts/lib/handback.ts`, `scripts/entries/runner.ts`. Test: `tests/handback.test.ts`.

Herdr tracks the Codex state, so the runner has no polling state machine. What is left to decide is small and pure: what to do after each Herdr wait returns.

- [ ] **Step 1: Failing tests.**
  - `gate result`: `gateResult("… RELAY_GATE:ab12:start")` is `start`, `…:cancel` is `cancel`, and a timeout error is `timed_out`.
  - `after the Codex prompt`: `afterPrompt("done")` and `afterPrompt("idle")` are `finished`. `afterPrompt("blocked")` is `wait_for_user` (notify one time, then wait). `afterPrompt(Stalled)` is `check_once` (read `agent get` one time, never re-send).
  - `after a stalled check`: `afterStalledCheck("working")` and `("blocked")` are `wait_for_user`. `("idle")`, `("done")` and `NoAgent` are `give_up` (notify and exit).
  - `hand-back target`: `handBackAction(true, "idle")` and `(true, "done")` give `prompt_claude`. `working`, `blocked`, `NoAgent` and `PaneGone` give `notify_only`. `handBack=false` always gives `notify_only`.
- [ ] **Step 2:** See them fail.
- [ ] **Step 3: Implement `handback.ts`**

```ts
// Pure decisions for the background runner. Herdr does the waiting; this decides what comes next.
import { AgentStatus, PromptOutcome } from "./herdr.ts";

export const Next = {
  Finished: "finished",
  WaitForUser: "wait_for_user", // Codex asked a question: notify once, then agent wait
  CheckOnce: "check_once",      // prompt stalled: read the state once, never re-send
  GiveUp: "give_up",
} as const;
export type Next = (typeof Next)[keyof typeof Next];

export const HandBack = { PromptClaude: "prompt_claude", NotifyOnly: "notify_only" } as const;
export type HandBack = (typeof HandBack)[keyof typeof HandBack];

const READY_FOR_INPUT = new Set<string>(["idle", "done"]);

export function afterPrompt(outcome: string): Next {
  if (outcome === PromptOutcome.Stalled) return Next.CheckOnce;
  if (outcome === "blocked") return Next.WaitForUser;
  return READY_FOR_INPUT.has(outcome) ? Next.Finished : Next.GiveUp;
}

export function afterStalledCheck(status: string): Next {
  return status === "working" || status === "blocked" ? Next.WaitForUser : Next.GiveUp;
}

export function handBackAction(handBack: boolean, claudeStatus: string): HandBack {
  return handBack && READY_FOR_INPUT.has(claudeStatus) ? HandBack.PromptClaude : HandBack.NotifyOnly;
}
```

`gateResult` also lives here: it matches `RELAY_GATE:<id>:(start|cancel)` on the text that `waitForOutput` returns.

- [ ] **Step 4: Implement the runner entry.** It follows the numbered steps in the design decisions:
  1. In confirm mode, `waitForOutput(codexPane, regex, 24 h)`, then `gateResult`. On `cancel` or `timed_out`, exit.
  2. `startAgent(codexName, "codex", codexPane, ["--add-dir", handoffsDir, ...splitArgs(codexArgs)])`. On a name clash, pick the next free name one time.
  3. `promptAndWait(codexName, codexPrompt)`, then act on `afterPrompt`. For `wait_for_user`: notify "Codex needs your answer in relay-codex", then `waitUntilFinished(codexName)`.
  4. Notify "Codex finished", with the report path or "no report".
  5. Sleep until `resetAfter + 60`, one sleep per 10 minutes, so a clock change after the Mac wakes is handled.
  6. `handBackAction(handBack, agentStatus(claudeName))`. For `prompt_claude`, `promptAgent(claudeName, handBackPrompt(report, existsSync(report)))`. Otherwise notify "Codex finished. Claude was busy, so read <report> when you go back".
  Log errors to `<data>/errors.log` and exit 0. `splitArgs` is a small quote-aware splitter with its own test (`--sandbox "workspace write"` gives two arguments), because `codex_args` never goes through a shell.
- [ ] **Step 5:** Tests pass. Stage. Commit message: `feat: runner starts codex through herdr and hands back`.

---

## Chunk 3: Wiring, setup, verification

### Task 10: Hook entries and `hooks/hooks.json`

**Files:** Create `scripts/entries/tool-batch.ts`, `stop.ts`, `stop-failure.ts`, `hooks/hooks.json`.

Each entry does these steps: read stdin, return 0 for subagents, load the options, the snapshot and the state, call the `decide` function, save the new state (with `resetAfter` = the latest `resetsAt` of the windows over the threshold), do the side effect, then print the hook JSON. Any error is caught and written to `<data>/errors.log`, and the entry returns 0. A broken plugin must never block Claude.

- `tool-batch.ts`: for `inject_instruction`, print `{"hookSpecificOutput": {"hookEventName": "PostToolBatch", "additionalContext": instruction(over)}}`.
- `stop.ts`: for `block_stop`, print `{"decision": "block", "reason": instruction(over)}`. For `hand_off_summary`, use `extractHandoff(last_assistant_message)`. For `hand_off_transcript`, use `fallbackHandoff(...)`. Both then call `handOff` and print `{"systemMessage": message}`.
- `stop-failure.ts`: for `hand_off_transcript`, call `handOff`. Output is ignored here, so the Herdr notification tells the user. Outside Herdr, print `terminalSequence` with an OSC 9 desktop notification. Check the allowed format in the "Emit terminal notifications" section of the hooks docs first.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node --no-warnings \"${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs\" session-start", "timeout": 10 }] }],
    "PostToolBatch": [{ "hooks": [{ "type": "command", "command": "node --no-warnings \"${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs\" tool-batch", "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node --no-warnings \"${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs\" stop", "timeout": 30 }] }],
    "StopFailure": [{ "matcher": "rate_limit", "hooks": [{ "type": "command", "command": "node --no-warnings \"${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs\" stop-failure", "timeout": 30 }] }]
  }
}
```

- [ ] **Step 1:** Write the entries and `hooks.json`.
- [ ] **Step 2: Smoke test by pipe.** Put a usage file at 90%, then pipe a fake `PostToolBatch` payload into `node --no-warnings scripts/run.mjs tool-batch` with `CLAUDE_PLUGIN_DATA=<tmp>`. Expected: `additionalContext` JSON. Run it again. Expected: no output (already warned). Pipe a `Stop` payload that has the marker in `last_assistant_message`, without Herdr env. Expected: `systemMessage` with the manual command, and `handoffs/<session>.md` exists.
- [ ] **Step 3:** Stage. Commit message: `feat: wire hooks`.

### Task 11: Setup command and `SessionStart`

**Files:** Create `commands/setup.md`, `scripts/entries/setup.ts`, `scripts/entries/session-start.ts`.

- `setup.md` tells Claude to run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" setup "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"` (both variables are replaced in command content) and to report the result. It also says that setup changes `statusLine` in `~/.claude/settings.json` and keeps any existing status line.
- `setup.ts`: run `installLauncher`, then `installStatusLine(SETTINGS_PATH, "'<data>/bin/relay' statusline")`. When it returns an old command, write that command to `chain.json`. Print what changed.
- `session-start.ts`: always run `installLauncher(CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA)`, so the launcher points at the current plugin version. If `statusLine` in settings is not ours, print `{"systemMessage": "relay: run /relay:setup to connect the status line"}`.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** Run setup against a temp `HOME`, so the real settings file is not touched. Check `statusLine`, `chain.json` and `bin/relay`. Pipe a sample status line JSON into `bin/relay statusline` and check the output line and the usage file. Run setup again and check that nothing changes.
- [ ] **Step 3:** Stage. Commit message: `feat: setup command for status line`.

### Task 12: README

- [ ] Write `README.md`: what the plugin does (with the flow diagram), what it needs (Node 22.18+, Claude Pro/Max for `rate_limits`, Herdr, Codex), install (`/plugin marketplace add IsuruDR/claude-relay`, then `/plugin install relay@relay`, then `/relay:setup`), the settings table, the three modes, how to hand back by hand after a restart, and how to undo the status line change. Stage. Commit message: `docs: readme`.

### Task 13: Checks and review

- [ ] `npm test`. Expected: all tests pass.
- [ ] `npm run typecheck`. Expected: no errors. `erasableSyntaxOnly` catches syntax that Node cannot strip.
- [ ] `npm run lint`, then `npm run format`. Fix everything that lint finds.
- [ ] `claude plugin validate .` (check the exact command with `claude plugin --help`). Expected: the manifest and hooks are valid.
- [ ] Code review with superpowers:requesting-code-review against `git diff main --stat`. Iterate once, and list any issues that are still open.

### Task 14: End-to-end check in Herdr

- [ ] Install from the local path: `claude plugin marketplace add ~/.worktrees/relay/v5-core`, then `claude plugin install relay@relay`, then run `/relay:setup` in a Claude session in a Herdr pane.
- [ ] Check that the status line shows `5h N% | 7d N% | ctx N%`, and that `~/.claude/plugins/data/<id>/usage/<session>.json` exists.
- [ ] In `/config`, set the 5-hour threshold to the minimum (50) or just under your current usage. Give Claude a task with several tool calls. Expected: in the middle of the turn, Claude says it got the limit instruction, finishes the step, and replies with the marker handoff. A `relay-codex` pane opens beside it with the confirm screen, and a Herdr notification shows.
- [ ] Push `[a]`. Expected: `herdr agent list` shows a `codex` agent named `relay-codex`, and your Claude agent has its own name or `relay-claude`. Codex reads the handoff and continues. `/config` shows `switch_mode` = `auto`.
- [ ] Move the Claude pane to another workspace while Codex works (`herdr pane move`). Expected: the hand-back still reaches Claude, because the runner targets the agent name and not the pane ID.
- [ ] Check the backup path: pipe a `StopFailure` `rate_limit` payload into `run.mjs stop-failure` in a Herdr pane. Expected: a pane with the transcript-based handoff.
- [ ] **Hand-back:** run the runner by hand with `--reset-after <now + 120>`, so we do not wait for a real reset. Give Codex a small task. Expected: `<session>.report.md` exists when Codex finishes, then a "Codex finished" notification shows. About 3 minutes later, the Claude pane gets the hand-back prompt, reads the report and continues.
- [ ] **Hand-back, busy Claude:** do it again, and type something into Claude before the reset time. Expected: notification only, and no text is typed into Claude.
- [ ] **Old Node:** run `run.mjs session-start` with an older Node (for example `npx -y node@20 scripts/run.mjs session-start`). Expected: the "relay needs Node 22.18 or later" message and exit 0.
- [ ] Set the thresholds back to 85/95 and `switch_mode` back to `confirm`.

---

### After approval (repo rules)

- This plan and `v6-patient-courier.md` are mirrored to `~/Documents/obsidian/brainstorm/brainstorm/personal/relay/plans/`, with the ASCII diagrams turned into Mermaid. The v1-v4 plans stay as history (v1, v2: Python; v3, v4: TypeScript before the Herdr agent commands).
- Build order: Part 2 (Tasks 0-14) now. v6 (Tasks 15-19) after this plan is merged, because it reuses the launcher, `herdr.ts` and `settings.ts`.
- Do not push to GitHub or publish the marketplace without asking first.

## Watch out for

- **Only Pro/Max users get `rate_limits`.** API-key users get no usage file, so the plugin does nothing. The README says this.
- **The status line refreshes only on events.** A turn that makes one huge model call without tool calls can go past the threshold before any hook runs. The 85% default leaves room for this. The `StopFailure` backup covers the rest.
- **Two agents, one working tree.** Codex works in the same folder that Claude left. That is safe because Claude is stopped by then. If you type into Claude again before the limit resets, both agents can edit the same files.
- **Codex approval prompts** stop Codex, and Herdr shows it as `blocked`. With `codex_args`, you can choose a looser sandbox if you trust the repo.
- **`[a]` changes a user setting from a script.** It edits only the one documented key, with an atomic write. Other settings are kept.
- **The runner is lost if the machine restarts.** The handoff and report files stay in the data folder. The README says how to hand back by hand: tell Claude "read <report> and continue".
- **Hand-back uses Claude's new budget.** It sends one prompt after the reset, which is the point. If you do not want that, turn off `hand_back`.
- **Codex idle vs finished.** Codex is `idle` at its first prompt and again when it finishes. `agent prompt --wait` handles this: it counts a settled state only after it saw activity from our prompt. If Codex asks a question and waits (`blocked`), you get a notification. The runner does not answer for you.
- **Naming your Claude agent.** When Claude has no name, we give it `relay-claude`. That name shows in the Herdr sidebar and stays until Claude exits. If you name your agents yourself, we keep your name.
- **Node type stripping is strict about syntax.** No `enum`, no parameter properties, and extensions in every import. `tsc` with `erasableSyntaxOnly` catches these before Node does.


## Implementation notes

- **Task 0, test command.** `node --test` takes files or glob patterns, not a folder. `node --test tests/` tried to load `tests/` as a module and failed. The script is `node --no-warnings --test 'tests/**/*.test.ts'`.
- **Task 0, dev tools are devDependencies.** `npx -p @types/node` puts the types in the npx cache, where `tsc` cannot find them. So TypeScript 5.9.3, `@types/node` 22.20.4 and Biome 2.5.14 are `devDependencies` (exact versions), and the scripts call `tsc` and `biome` directly. The plugin still has zero runtime dependencies: the hooks need no `node_modules/`, and `node_modules/` is not committed.
- **Task 0, config details.** `tsconfig.json` has `allowJs` and `checkJs`, so `tsc` also checks the plain-JS guard (`version.mjs` has JSDoc types). The dynamic import in `run.mjs` passes `new URL(...).href`, because `tsc` wants a string. Biome 2.5 renamed `"recommended": true` to `"preset": "recommended"`. `biome migrate` wrote `"preset": "none"`, which turns all rules off, so we set it back by hand.
