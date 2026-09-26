import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentStatus,
  agentName,
  agentStatus,
  findFreePane,
  herdrContext,
  listAgentNames,
  listPaneLabels,
  notify,
  OutputWait,
  openPane,
  PromptOutcome,
  promptAgent,
  promptAndWait,
  renameAgent,
  runInPane,
  startAgent,
  waitForOutput,
  waitUntilFinished,
} from "../scripts/lib/herdr.ts";
import { fails, fakeHerdr, fixture, ok } from "./helpers/fake-herdr.ts";

const ctx = { paneId: "w1:p1", workspaceId: "w1" };

test("context is undefined outside Herdr", () => {
  assert.equal(herdrContext({}), undefined);
  assert.equal(herdrContext({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }), undefined);
  assert.deepEqual(herdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }), ctx);
});

test("split opens a labelled pane beside Claude", () => {
  const { run, calls } = fakeHerdr([
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
  ]);
  assert.equal(openPane(ctx, "split", "/repo", "boomerang-codex", run), "w2:p5");
  assert.deepEqual(calls[0].args, [
    "pane",
    "split",
    "--pane",
    "w1:p1",
    "--direction",
    "right",
    "--cwd",
    "/repo",
    "--no-focus",
  ]);
  assert.deepEqual(calls[1].args, ["pane", "rename", "w2:p5", "boomerang-codex"]);
});

test("tab opens a labelled tab in the same workspace", () => {
  const { run, calls } = fakeHerdr([
    [["tab", "create"], ok("tab-create.json")],
    [["pane", "rename"], ok("pane-rename.json")],
  ]);
  assert.equal(openPane(ctx, "tab", "/repo", "boomerang-codex", run), "w2:p4");
  assert.deepEqual(calls[0].args, [
    "tab",
    "create",
    "--workspace",
    "w1",
    "--cwd",
    "/repo",
    "--label",
    "boomerang-codex",
    "--no-focus",
  ]);
  assert.deepEqual(calls[1].args, ["pane", "rename", "w2:p4", "boomerang-codex"]);
});

test("runInPane and notify send the right commands", () => {
  const { run, calls } = fakeHerdr([
    [["pane", "run"], ok("pane-run.json")],
    [["notification", "show"], ok("notification.json")],
  ]);
  runInPane("w2:p4", "echo hi", run);
  notify("Title", "Body", run);
  assert.deepEqual(calls[0].args, ["pane", "run", "w2:p4", "echo hi"]);
  assert.deepEqual(calls[1].args, ["notification", "show", "Title", "--body", "Body", "--sound", "request"]);
});

test("agentStatus reads the state, or says the agent is not found", () => {
  const found = fakeHerdr([[["agent", "get"], ok("agent-get-named.json")]]);
  assert.equal(agentStatus("bf-probe", found.run), "idle");
  const noAgent = fakeHerdr([[["agent", "get"], fails("agent-get-no-agent.stderr")]]);
  assert.equal(agentStatus("w2:p4", noAgent.run), AgentStatus.NotFound);
  const paneClosed = fakeHerdr([[["agent", "get"], fails("agent-get-pane-gone.stderr")]]);
  assert.equal(agentStatus("w2:p4", paneClosed.run), AgentStatus.NotFound);
});

test("agentName reads the name, or undefined when the agent has none", () => {
  const named = fakeHerdr([[["agent", "get"], ok("agent-get-named.json")]]);
  assert.equal(agentName("w2:p4", named.run), "bf-probe");
  const unnamedAgent = JSON.parse(fixture("agent-start.json"));
  delete unnamedAgent.result.agent.name;
  const unnamed = fakeHerdr([[["agent", "get"], { stdout: JSON.stringify(unnamedAgent) }]]);
  assert.equal(agentName("w2:p4", unnamed.run), undefined);
});

test("startAgent passes the name, kind, pane and native args", () => {
  const { run, calls } = fakeHerdr([[["agent", "start"], ok("agent-start.json")]]);
  startAgent("boomerang-codex", "codex", "w2:p4", ["--add-dir", "/d"], run);
  assert.deepEqual(calls[0].args, [
    "agent",
    "start",
    "boomerang-codex",
    "--kind",
    "codex",
    "--pane",
    "w2:p4",
    "--timeout",
    "60000",
    "--",
    "--add-dir",
    "/d",
  ]);
  assert.equal(calls[0].opts?.timeoutMs, 70_000);
});

test("promptAndWait returns the settled status, or a named outcome", () => {
  const done = fakeHerdr([[["agent", "prompt"], ok("agent-prompt-wait.json")]]);
  assert.equal(promptAndWait("bf-probe2", "task", done.run), "done");
  assert.deepEqual(done.calls[0].args, ["agent", "prompt", "bf-probe2", "task", "--wait"]);
  assert.equal(done.calls[0].opts?.timeoutMs, 0);

  const notRunning = fakeHerdr([[["agent", "prompt"], fails("agent-prompt-not-running.stderr")]]);
  assert.equal(promptAndWait("x", "task", notRunning.run), PromptOutcome.NotRunning);

  const stalled = fakeHerdr([
    [["agent", "prompt"], { errorJson: '{"error":{"code":"agent_prompt_stalled","message":"no activity"}}' }],
  ]);
  assert.equal(promptAndWait("x", "task", stalled.run), PromptOutcome.Stalled);
});

test("waitUntilFinished waits for done or idle with no limit", () => {
  const { run, calls } = fakeHerdr([[["agent", "wait"], ok("agent-wait.json")]]);
  assert.equal(waitUntilFinished("bf-probe2", run), "done");
  assert.deepEqual(calls[0].args, ["agent", "wait", "bf-probe2", "--until", "done", "--until", "idle"]);
  assert.equal(calls[0].opts?.timeoutMs, 0);
});

test("waitForOutput returns the matched line, a timeout, or a closed pane", () => {
  const matched = fakeHerdr([[["pane", "wait-output"], ok("wait-output-match.json")]]);
  assert.deepEqual(waitForOutput("w2:p4", "BOOM_FIX:(abc)", 86_400_000, matched.run), {
    kind: OutputWait.Matched,
    line: "BOOM_FIX:abc",
  });
  assert.deepEqual(matched.calls[0].args, [
    "pane",
    "wait-output",
    "w2:p4",
    "--regex",
    "BOOM_FIX:(abc)",
    "--timeout",
    "86400000",
  ]);
  const timedOut = fakeHerdr([[["pane", "wait-output"], fails("wait-output-timeout.stderr")]]);
  assert.deepEqual(waitForOutput("w2:p4", "x", 1500, timedOut.run), { kind: OutputWait.TimedOut });
  const gone = fakeHerdr([[["pane", "wait-output"], fails("pane-run-gone.stderr")]]);
  assert.deepEqual(waitForOutput("w2:p4", "x", 1500, gone.run), { kind: OutputWait.PaneGone });
});

test("rename and prompt without waiting", () => {
  const { run, calls } = fakeHerdr([
    [["agent", "rename"], ok("agent-rename.json")],
    [["agent", "prompt"], ok("agent-prompt-nowait.json")],
  ]);
  renameAgent("w1:p1", "boomerang-claude", run);
  promptAgent("boomerang-claude", "read the report", run);
  assert.deepEqual(calls[0].args, ["agent", "rename", "w1:p1", "boomerang-claude"]);
  assert.deepEqual(calls[1].args, ["agent", "prompt", "boomerang-claude", "read the report"]);
});

test("list live agent names and the pane labels of one workspace", () => {
  const { run } = fakeHerdr([
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
  ]);
  assert.deepEqual(listAgentNames(run), ["boomerang-codex"]);
  assert.deepEqual(listPaneLabels("w2", run), ["boomerang-codebase-scout"]);
});

test("unexpected errors keep the Herdr error code", () => {
  const { run } = fakeHerdr([[["pane", "run"], fails("pane-run-gone.stderr")]]);
  assert.throws(() => runInPane("w2:p4", "echo", run), { name: "HerdrError", code: "pane_not_found" });
});

test("findFreePane picks a labelled pane whose foreground program is a shell", () => {
  const panes = {
    result: {
      panes: [
        { pane_id: "w2:p4", workspace_id: "w2", label: "boomerang-codebase-scout" },
        { pane_id: "w2:p5", workspace_id: "w2", label: "boomerang-codebase-scout-2" },
        { pane_id: "w2:p6", workspace_id: "w2", label: "boomerang-codebase-scout-extra" },
        { pane_id: "w2:p7", workspace_id: "w2", label: "boomerang-codebase-scout-3" },
      ],
    },
  };
  const { run: base, calls } = fakeHerdr([[["pane", "list"], { stdout: JSON.stringify(panes) }]]);
  const run: typeof base = (args, opts) => {
    if (args[0] === "pane" && args[1] === "process-info") {
      calls.push({ args, opts });
      return fixture(args[3] === "w2:p4" ? "process-info-busy.json" : "process-info-shell.json");
    }
    return base(args, opts);
  };
  const ctx2 = { paneId: "w2:p1", workspaceId: "w2" };
  assert.equal(findFreePane(ctx2, "boomerang-codebase-scout", run), "w2:p5");
  assert.equal(
    calls.some((c) => c.args.includes("w2:p6")),
    false,
    "a label that only starts with the base name belongs to another agent",
  );
});

test("findFreePane returns undefined when every labelled pane is busy or none exists", () => {
  const panes = { result: { panes: [{ pane_id: "w2:p4", workspace_id: "w2", label: "boomerang-codebase-scout" }] } };
  const { run } = fakeHerdr([
    [["pane", "list"], { stdout: JSON.stringify(panes) }],
    [["pane", "process-info"], ok("process-info-busy.json")],
  ]);
  const ctx2 = { paneId: "w2:p1", workspaceId: "w2" };
  assert.equal(findFreePane(ctx2, "boomerang-codebase-scout", run), undefined);
  assert.equal(findFreePane(ctx2, "boomerang-log-digger", run), undefined);
});
