// Runs the real hook entries through run.mjs, the same way Claude Code does:
// JSON on stdin, plugin env vars, JSON on stdout. No Herdr env, so hand-offs use the notify path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDOFF_MARKER } from "../scripts/lib/handoff.ts";
import { resetAfterFor } from "../scripts/lib/hook-context.ts";

const RUN_MJS = new URL("../scripts/run.mjs", import.meta.url).pathname;
const HOOKS_JSON = new URL("../hooks/hooks.json", import.meta.url).pathname;
const FIXTURE_TRANSCRIPT = new URL("./fixtures/transcript.jsonl", import.meta.url).pathname;
const SOON = Math.floor(Date.now() / 1000) + 3600;

function dataDirWithUsage(pct: number): string {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  mkdirSync(join(dir, "usage"));
  writeFileSync(
    join(dir, "usage", "s1.json"),
    JSON.stringify({ five_hour: { used_percentage: pct, resets_at: SOON } }),
  );
  return dir;
}

/** The one handoff file of session s1 (names are s1-<time>.md). */
function handoffText(dir: string): string {
  const files = readdirSync(join(dir, "handoffs")).filter((f) => /^s1-\d+\.md$/.test(f));
  assert.equal(files.length, 1, `expected one handoff, found: ${files.join(", ")}`);
  return readFileSync(join(dir, "handoffs", files[0]), "utf8");
}

/** Hook processes never see the real home folder: no real settings.json, config.json or agents. */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "boomerang-home-"));
}

/** Claude Code sets CLAUDE_PROJECT_DIR for every hook; `host` lets a test drop it, as Codex does. */
function hook(
  entry: string,
  dataDir: string,
  input: Record<string, unknown>,
  home = tempHome(),
  host: NodeJS.ProcessEnv = { CLAUDE_PROJECT_DIR: tmpdir() },
) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: dataDir, ...host };
  const result = spawnSync(process.execPath, ["--no-warnings", RUN_MJS, entry], {
    input: JSON.stringify({ session_id: "s1", cwd: tmpdir(), ...input }),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

test("PostToolBatch warns once when usage is over the threshold", () => {
  const dir = dataDirWithUsage(90);
  const first = hook("tool-batch", dir, { hook_event_name: "PostToolBatch" });
  assert.equal(first.hookSpecificOutput.hookEventName, "PostToolBatch");
  assert.ok(first.hookSpecificOutput.additionalContext.includes("5-hour usage is at 90%"));
  assert.equal(hook("tool-batch", dir, { hook_event_name: "PostToolBatch" }), undefined);
});

test("PostToolBatch under the threshold, or from a subagent, says nothing", () => {
  assert.equal(hook("tool-batch", dataDirWithUsage(40), {}), undefined);
  assert.equal(hook("tool-batch", dataDirWithUsage(90), { agent_id: "sub-1" }), undefined);
});

test("Stop blocks with the instruction, then hands off Claude's summary", () => {
  const dir = dataDirWithUsage(90);
  const block = hook("stop", dir, { last_assistant_message: "working on it", stop_hook_active: false });
  assert.equal(block.decision, "block");
  assert.ok(block.reason.includes(HANDOFF_MARKER));

  const reply = `Stopping.\n${HANDOFF_MARKER}\n## Goal\nFinish the 429 path`;
  const handedOff = hook("stop", dir, { last_assistant_message: reply, stop_hook_active: true });
  assert.ok(handedOff.systemMessage.includes("handoff saved"));
  assert.equal(handoffText(dir), "## Goal\nFinish the 429 path\n");

  assert.equal(hook("stop", dir, { last_assistant_message: reply }), undefined, "only one handoff per window");
});

test("Stop falls back to the transcript when Claude ignores the reminder", () => {
  const dir = dataDirWithUsage(90);
  hook("stop", dir, { last_assistant_message: "hmm", stop_hook_active: false });
  const fallback = hook("stop", dir, {
    last_assistant_message: "still no handoff",
    stop_hook_active: true,
    transcript_path: FIXTURE_TRANSCRIPT,
  });
  assert.ok(fallback.systemMessage.includes("handoff saved"));
  const text = handoffText(dir);
  assert.ok(text.includes("Also cover the 429 path"));
  assert.ok(text.includes(FIXTURE_TRANSCRIPT));
});

test("StopFailure on a rate limit hands off and sends a desktop notification", () => {
  const dir = dataDirWithUsage(100);
  const out = hook("stop-failure", dir, { error: "rate_limit", transcript_path: FIXTURE_TRANSCRIPT });
  assert.ok(handoffText(dir).includes("usage limit"));
  const sequence: string = out.terminalSequence;
  assert.ok(sequence.startsWith("\u001b]9;boomerang: "), "starts with OSC 9");
  assert.ok(sequence.endsWith("\u0007"), "ends with BEL");
});

test("a hook error is logged and never blocks Claude", () => {
  const dir = dataDirWithUsage(90);
  hook("stop", dir, { last_assistant_message: "working", stop_hook_active: false }); // now warned
  writeFileSync(join(dir, "handoffs"), "a file where a folder should be");
  const out = hook("stop", dir, { last_assistant_message: `${HANDOFF_MARKER}\nx`, stop_hook_active: true });
  assert.equal(out, undefined);
  assert.ok(readFileSync(join(dir, "errors.log"), "utf8").includes("[stop]"));

  // The phase was not moved to handed-off, so the next stop tries the handoff again.
  const again = hook("stop", dir, { last_assistant_message: `${HANDOFF_MARKER}\nx`, stop_hook_active: true });
  assert.equal(again, undefined);
  assert.equal(readFileSync(join(dir, "errors.log"), "utf8").split("[stop]").length - 1, 2);
});

/** The run.mjs entry of every hook in hooks.json: the last word of its command. */
function pluginHookEntries(): string[] {
  type HookGroup = { hooks: { command: string }[] };
  const config: { hooks: Record<string, HookGroup[]> } = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const groups = Object.values(config.hooks).flat();
  return groups.flatMap((group) => group.hooks.map((h) => h.command.split(" ").at(-1) ?? ""));
}

test("run by Codex (no CLAUDE_PROJECT_DIR), every plugin hook does nothing", () => {
  const dir = dataDirWithUsage(90);
  const home = tempHome();
  const before = readdirSync(dir);
  // Input that makes each entry act when it runs: over the threshold, a first stop, a rate limit.
  const input = {
    last_assistant_message: "working",
    stop_hook_active: false,
    error: "rate_limit",
    transcript_path: FIXTURE_TRANSCRIPT,
  };
  const entries = pluginHookEntries();
  assert.ok(entries.length >= 4, `found the hooks: ${entries.join(", ")}`);
  for (const entry of entries) {
    const out = hook(entry, dir, input, home, {});
    assert.equal(out, undefined, `${entry} said nothing`);
  }
  assert.deepEqual(readdirSync(dir), before, "no state, handoff or plugin_root written");
  assert.deepEqual(readdirSync(home), [], "nothing written to the home folder");
});

test("resetAfter is the latest reset of the windows over the threshold", () => {
  const over = [
    { name: "five_hour" as const, usedPercentage: 90, resetsAt: 100 },
    { name: "seven_day" as const, usedPercentage: 97, resetsAt: 900 },
  ];
  assert.equal(resetAfterFor(over, 5, 0), 900);
  assert.equal(resetAfterFor([], 5, 42), 42, "keeps the saved value when no window is over");
  assert.equal(resetAfterFor([], 5, 0), 5 + 5 * 3600, "falls back to five hours from now");
});

test("an interrupted dispatch is not repeated: the next stop marks it handed off and says where the handoff is", () => {
  const dir = dataDirWithUsage(90);
  hook("stop", dir, { last_assistant_message: "working", stop_hook_active: false }); // now warned
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "s1.dispatching"), JSON.stringify({ resetAfter: SOON, startedAt: 1 }));

  const out = hook("stop", dir, { last_assistant_message: `${HANDOFF_MARKER}\nx`, stop_hook_active: true });
  assert.ok(out.systemMessage.includes("interrupted"));
  assert.equal(existsSync(join(dir, "handoffs")), false, "no second handoff");
  assert.equal(hook("stop", dir, { last_assistant_message: `${HANDOFF_MARKER}\nx` }), undefined, "now handed off");
});

test("a successful dispatch leaves no lock behind", () => {
  const dir = dataDirWithUsage(90);
  hook("stop", dir, { last_assistant_message: "working", stop_hook_active: false });
  hook("stop", dir, { last_assistant_message: `${HANDOFF_MARKER}\nx`, stop_hook_active: true });
  assert.equal(existsSync(join(dir, "state", "s1.dispatching")), false);
});

test("a session id with path characters is ignored", () => {
  const dir = dataDirWithUsage(90);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tempHome(), CLAUDE_PLUGIN_DATA: dir };
  const result = spawnSync(process.execPath, ["--no-warnings", RUN_MJS, "tool-batch"], {
    input: JSON.stringify({ session_id: "../../escape" }),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a hook uses the threshold from config.json in the home folder", () => {
  const home = tempHome();
  mkdirSync(join(home, ".claude", "boomerang"), { recursive: true });
  writeFileSync(join(home, ".claude", "boomerang", "config.json"), JSON.stringify({ five_hour_threshold: 60 }));
  const input = { hook_event_name: "PostToolBatch" };
  assert.equal(hook("tool-batch", dataDirWithUsage(70), input), undefined, "70% is under the default of 85%");
  const warned = hook("tool-batch", dataDirWithUsage(70), input, home);
  assert.ok(warned.hookSpecificOutput.additionalContext.includes("5-hour usage is at 70%"));
});
