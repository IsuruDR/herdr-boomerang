import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gateLine } from "../scripts/lib/handback.ts";
import { HerdrError } from "../scripts/lib/herdr.ts";
import { type RunnerConfig, runHandoff } from "../scripts/lib/runner.ts";
import { fails, fakeHerdr, fixture, ok } from "./helpers/fake-herdr.ts";

const NOW = 1_000_000;

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const handoffPath = join(dataDir, "handoffs", "s1.md");
  return {
    dataDir,
    codexPane: "w2:p5",
    codexName: "boomerang-codex",
    claudeName: "boomerang-claude",
    handoffPath,
    cwd: "/repo",
    mode: "confirm",
    gateId: "ab12cd34",
    resetAfter: NOW + 3600,
    handBack: true,
    codexArgs: "",
    ...overrides,
  };
}

const gateStart = JSON.stringify({ result: { matched_line: gateLine("ab12cd34", "start") } });
const gateCancel = JSON.stringify({ result: { matched_line: gateLine("ab12cd34", "cancel") } });
const notRunning = fixture("agent-prompt-not-running.stderr");

function clock() {
  let now = NOW;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (seconds: number) => {
      slept.push(seconds);
      now += seconds;
    },
    slept,
  };
}

const args = (calls: { args: string[] }[], verb: string, sub: string) =>
  calls.filter((c) => c.args[0] === verb && c.args[1] === sub).map((c) => c.args);

test("confirm, Codex finishes, Claude is idle after the reset: Claude gets the hand-back", async () => {
  const cfg = config();
  const { run, calls } = fakeHerdr([
    [["pane", "wait-output"], { stdout: gateStart }],
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], ok("agent-prompt-wait.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const time = clock();
  await runHandoff(cfg, { run, now: time.now, sleep: time.sleep });

  const [start] = args(calls, "agent", "start");
  assert.deepEqual(start.slice(-9), [
    "--",
    "--add-dir",
    join(cfg.dataDir, "handoffs"),
    "--sandbox",
    "workspace-write",
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "plugins.boomerang@boomerang.enabled=false",
  ]);
  const prompts = args(calls, "agent", "prompt");
  assert.ok(prompts[0][3].includes(cfg.handoffPath));
  assert.equal(prompts[0][4], "--wait");
  assert.ok(prompts[1][3].includes("stopped without writing a report"));
  assert.ok(time.now() >= cfg.resetAfter + 60, "slept until after the reset");
  assert.ok(Math.max(...time.slept) <= 600, "sleeps in steps of at most 10 minutes");
});

test("the hand-back points at the report when Codex wrote one", async () => {
  const cfg = config({ mode: "auto" });
  const { run, calls } = fakeHerdr([
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], ok("agent-prompt-wait.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const report = cfg.handoffPath.replace(/\.md$/, ".report.md");
  mkdirSync(dirname(report), { recursive: true });
  const time = clock();
  await runHandoff(cfg, {
    run,
    now: time.now,
    sleep: async (seconds) => {
      writeFileSync(report, "## What I did\n");
      await time.sleep(seconds);
    },
    fileExists: (path) => path === report,
  });
  assert.equal(args(calls, "pane", "wait-output").length, 0, "auto mode does not wait for the gate");
  const [, handBack] = args(calls, "agent", "prompt");
  assert.ok(handBack[3].includes(report));
});

test("cancel on the confirm screen starts nothing", async () => {
  const { run, calls } = fakeHerdr([[["pane", "wait-output"], { stdout: gateCancel }]]);
  const time = clock();
  await runHandoff(config(), { run, now: time.now, sleep: time.sleep });
  assert.equal(args(calls, "agent", "start").length, 0);
});

test("Codex exiting at start is retried once with --no-daemon", async () => {
  let prompts = 0;
  const { run: base, calls } = fakeHerdr([
    [["pane", "wait-output"], { stdout: gateStart }],
    [["agent", "start"], ok("agent-start.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const run: typeof base = (a, o) => {
    if (a[0] === "agent" && a[1] === "prompt" && a[2] === "boomerang-codex") {
      calls.push({ args: a, opts: o });
      prompts++;
      if (prompts === 1) throw HerdrError.fromStderr(a, notRunning);
      return fixture("agent-prompt-wait.json");
    }
    return base(a, o);
  };
  const time = clock();
  await runHandoff(config(), { run, now: time.now, sleep: time.sleep });
  const starts = args(calls, "agent", "start");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].includes("--no-daemon"), false);
  assert.equal(starts[1].includes("--no-daemon"), true);
});

test("a busy Claude after the reset gets a notification, not a prompt", async () => {
  const busy = JSON.parse(fixture("agent-get-named.json"));
  busy.result.agent.agent_status = "working";
  const { run, calls } = fakeHerdr([
    [["pane", "wait-output"], { stdout: gateStart }],
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], ok("agent-prompt-wait.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], { stdout: JSON.stringify(busy) }],
  ]);
  const time = clock();
  await runHandoff(config(), { run, now: time.now, sleep: time.sleep });
  assert.equal(args(calls, "agent", "prompt").length, 1, "only the Codex prompt");
  const notes = args(calls, "notification", "show");
  assert.ok(notes.some((n) => n.join(" ").includes("Claude was busy")));
});

test("Codex failing to start still leads to the hand-back after the reset", async () => {
  const { run, calls } = fakeHerdr([
    [["pane", "wait-output"], { stdout: gateStart }],
    [["agent", "start"], { errorJson: '{"error":{"code":"agent_not_ready","message":"codex was not ready in time"}}' }],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const time = clock();
  await runHandoff(config(), { run, now: time.now, sleep: time.sleep });
  const notes = args(calls, "notification", "show").map((n) => n.join(" "));
  assert.ok(notes.some((n) => n.includes("Codex could not start") && n.includes("not ready in time")));
  const prompts = args(calls, "agent", "prompt");
  assert.equal(prompts.length, 1, "only the hand-back prompt to Claude");
  assert.equal(prompts[0][2], "boomerang-claude");
});

test("an unclosed quote in the Codex arguments is reported, not a silent crash", async () => {
  const { run, calls } = fakeHerdr([
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const time = clock();
  await runHandoff(config({ mode: "auto", codexArgs: '--x "oops' }), { run, now: time.now, sleep: time.sleep });
  assert.ok(args(calls, "notification", "show").some((n) => n.join(" ").includes("unclosed")));
});

test("without a Claude name the runner only notifies after the reset", async () => {
  const { run, calls } = fakeHerdr([
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], ok("agent-prompt-wait.json")],
    [["notification", "show"], ok("notification.json")],
  ]);
  const time = clock();
  await runHandoff(config({ mode: "auto", claudeName: "" }), { run, now: time.now, sleep: time.sleep });
  assert.equal(args(calls, "agent", "get").length, 0);
  assert.equal(args(calls, "agent", "prompt").length, 1, "only the Codex prompt");
  assert.ok(args(calls, "notification", "show").some((n) => n.join(" ").includes("Claude's limit has reset")));
});

test("a blocked Codex notifies once, then waits until it finishes", async () => {
  const blocked = JSON.parse(fixture("agent-prompt-wait.json"));
  blocked.result.agent.agent_status = "blocked";
  const { run, calls } = fakeHerdr([
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], { stdout: JSON.stringify(blocked) }],
    [["agent", "wait"], ok("agent-wait.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const time = clock();
  await runHandoff(config({ mode: "auto" }), { run, now: time.now, sleep: time.sleep });
  const notes = args(calls, "notification", "show").map((n) => n.join(" "));
  assert.equal(notes.filter((n) => n.includes("Codex needs your answer")).length, 1);
  assert.deepEqual(args(calls, "agent", "wait")[0], [
    "agent",
    "wait",
    "boomerang-codex",
    "--until",
    "done",
    "--until",
    "idle",
  ]);
  assert.ok(notes.some((n) => n.includes("Codex finished")));
});

test("a pane closed during the confirm screen ends the runner quietly", async () => {
  const { run, calls } = fakeHerdr([[["pane", "wait-output"], fails("pane-run-gone.stderr")]]);
  const time = clock();
  await runHandoff(config(), { run, now: time.now, sleep: time.sleep });
  assert.equal(calls.length, 1);
  assert.equal(time.slept.length, 0);
});

test("the user's own sandbox choice replaces the workspace-write default", async () => {
  for (const codexArgs of [
    "-s danger-full-access",
    "--sandbox read-only",
    "--dangerously-bypass-approvals-and-sandbox",
  ]) {
    const { run, calls } = fakeHerdr([
      [["agent", "start"], ok("agent-start.json")],
      [["agent", "prompt", "boomerang-codex"], ok("agent-prompt-wait.json")],
      [["notification", "show"], ok("notification.json")],
      [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
      [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
    ]);
    const time = clock();
    await runHandoff(config({ mode: "auto", codexArgs }), { run, now: time.now, sleep: time.sleep });
    const [start] = args(calls, "agent", "start");
    assert.equal(start.includes("workspace-write"), false, codexArgs);
  }
});

test("a prompt lost while Codex was still loading is sent once more", async () => {
  let prompts = 0;
  const stalled = '{"error":{"code":"agent_prompt_stalled","message":"no activity"}}';
  const { run: base, calls } = fakeHerdr([
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "get", "boomerang-codex"], ok("agent-get-named.json")], // idle: the text was lost
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const run: typeof base = (a, o) => {
    if (a[0] === "agent" && a[1] === "prompt" && a[2] === "boomerang-codex") {
      calls.push({ args: a, opts: o });
      prompts++;
      if (prompts === 1) throw HerdrError.fromStderr(a, stalled);
      return fixture("agent-prompt-wait.json");
    }
    return base(a, o);
  };
  const time = clock();
  await runHandoff(config({ mode: "auto" }), { run, now: time.now, sleep: time.sleep });
  assert.equal(args(calls, "agent", "prompt").filter((p) => p[2] === "boomerang-codex").length, 2);
  assert.ok(args(calls, "notification", "show").some((n) => n.join(" ").includes("Codex finished")));
  assert.equal(time.slept[0], 3, "waits for Codex to settle after the start");
});

test("a stalled prompt to a working Codex is never sent again", async () => {
  const working = JSON.parse(fixture("agent-get-named.json"));
  working.result.agent.agent_status = "working";
  const { run, calls } = fakeHerdr([
    [["agent", "start"], ok("agent-start.json")],
    [["agent", "prompt", "boomerang-codex"], { errorJson: '{"error":{"code":"agent_prompt_stalled","message":"x"}}' }],
    [["agent", "get", "boomerang-codex"], { stdout: JSON.stringify(working) }],
    [["agent", "wait"], ok("agent-wait.json")],
    [["notification", "show"], ok("notification.json")],
    [["agent", "get", "boomerang-claude"], ok("agent-get-named.json")],
    [["agent", "prompt", "boomerang-claude"], ok("agent-prompt-nowait.json")],
  ]);
  const time = clock();
  await runHandoff(config({ mode: "auto" }), { run, now: time.now, sleep: time.sleep });
  assert.equal(args(calls, "agent", "prompt").filter((p) => p[2] === "boomerang-codex").length, 1);
  assert.equal(args(calls, "agent", "wait").length, 1);
});
