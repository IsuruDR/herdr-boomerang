import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DelegateOutcome, delegate, type Headless, pruneDelegations } from "../scripts/lib/delegate.ts";
import { HerdrError, type Runner } from "../scripts/lib/herdr.ts";
import { DEFAULT_OPTIONS } from "../scripts/lib/hook-io.ts";
import { ModelCheck, modelAvailability } from "../scripts/lib/models.ts";
import { fakeHerdr, fixture, ok } from "./helpers/fake-herdr.ts";

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", HERDR_WORKSPACE_ID: "w2" };
const ESC = String.fromCharCode(27);
const available = () => ({ kind: ModelCheck.Available }) as const;

function panesWith(labels: Array<[string, string]>): string {
  return JSON.stringify({
    result: { panes: labels.map(([id, label]) => ({ pane_id: id, workspace_id: "w2", label })) },
  });
}

/**
 * A fake Herdr for a delegation: `pane run` writes the report (with color codes) that OpenCode
 * would write, and wait-output answers with the marker line for the id in the command.
 */
function delegationHerdr(opts: { panes: string; busy?: string[]; exitCode?: number; timeout?: boolean }) {
  const { run: base, calls } = fakeHerdr([
    [["pane", "list"], { stdout: opts.panes }],
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
  ]);
  let command = "";
  const run: Runner = (args, runOpts) => {
    if (args[0] === "pane" && args[1] === "process-info") {
      calls.push({ args, opts: runOpts });
      return fixture(opts.busy?.includes(args[3]) ? "process-info-busy.json" : "process-info-shell.json");
    }
    if (args[0] === "pane" && args[1] === "run") {
      calls.push({ args, opts: runOpts });
      command = args[3];
      const report = /(\/[^'\s]+\/delegations\/[^'\s]+\.md)/.exec(command)?.[1]; // quotes are escaped inside sh -c
      if (!report) throw new Error(`fake herdr: no report path in ${command}`); // never write a stray file
      writeFileSync(report, `${ESC}[1mFound it${ESC}[0m\nscripts/lib/herdr.ts:120\n`);
      return fixture("pane-run.json");
    }
    if (args[0] === "pane" && args[1] === "wait-output") {
      calls.push({ args, opts: runOpts });
      if (opts.timeout) throw HerdrError.fromStderr(args, fixture("wait-output-timeout.stderr"));
      const id = / DONE ([0-9a-f]+) /.exec(command)?.[1] ?? "";
      return JSON.stringify({ result: { matched_line: `BOOMERANG_DONE:${id}:${opts.exitCode ?? 0}` } });
    }
    return base(args, runOpts);
  };
  return { run, calls, command: () => command };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    agent: "codebase-scout",
    task: "Where is the partner credential resolved?",
    cwd: "/repo",
    env: HERDR_ENV as NodeJS.ProcessEnv,
    dataDir: mkdtempSync(join(tmpdir(), "boomerang-")),
    options: DEFAULT_OPTIONS,
    headless: (() => {
      throw new Error("headless must not run inside Herdr");
    }) as Headless,
    checkModel: available,
    ...overrides,
  };
}

test("in Herdr it reuses the free pane, hides the marker from the command, and returns a clean report", () => {
  const herdr = delegationHerdr({ panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]) });
  const result = delegate({ ...input(), run: herdr.run });
  assert.deepEqual(result, { kind: DelegateOutcome.Done, report: "Found it\nscripts/lib/herdr.ts:120\n" });
  const [paneRun] = herdr.calls.filter((c) => c.args[1] === "run");
  assert.equal(paneRun.args[2], "w2:p4");
  const command = herdr.command();
  assert.ok(command.startsWith("sh -c "), command);
  for (const part of [
    "opencode run --agent",
    "'codebase-scout'",
    "-m",
    DEFAULT_OPTIONS.cheapModel,
    "--dir",
    "'/repo'",
  ]) {
    assert.ok(command.includes(part), `missing ${part}`);
  }
  assert.equal(command.includes("BOOMERANG_DONE"), false, "the typed command must not hold the full marker");
  assert.equal(
    herdr.calls.some((c) => c.args[1] === "split"),
    false,
  );
});

test("a busy labelled pane means a new pane with the next free name", () => {
  const herdr = delegationHerdr({
    panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]),
    busy: ["w2:p4"],
  });
  const result = delegate({ ...input(), run: herdr.run });
  assert.equal(result.kind, DelegateOutcome.Done);
  const rename = herdr.calls.find((c) => c.args[1] === "rename");
  assert.deepEqual(rename?.args, ["pane", "rename", "w2:p5", "boomerang-codebase-scout-2"]);
});

test("outside Herdr it runs headless with the same OpenCode arguments", () => {
  const seen: string[][] = [];
  const headless: Headless = (args) => {
    seen.push(args);
    return { code: 0, output: `${ESC}[32mpaths${ESC}[0m\n`, timedOut: false };
  };
  const { run, calls } = fakeHerdr([]);
  const result = delegate({ ...input({ env: {}, headless }), run });
  assert.deepEqual(result, { kind: DelegateOutcome.Done, report: "paths\n" });
  assert.deepEqual(seen[0], [
    "run",
    "--agent",
    "codebase-scout",
    "-m",
    DEFAULT_OPTIONS.cheapModel,
    "--dir",
    "/repo",
    "--",
    "Where is the partner credential resolved?",
  ]);
  assert.equal(calls.length, 0);
});

test("an unavailable model stops before anything runs", () => {
  const { run, calls } = fakeHerdr([]);
  const result = delegate({
    ...input({ checkModel: () => ({ kind: ModelCheck.Unavailable, reason: "model x is not in `opencode models`" }) }),
    run,
  });
  assert.deepEqual(result, { kind: DelegateOutcome.Unavailable, reason: "model x is not in `opencode models`" });
  assert.equal(calls.length, 0);
});

test("a non-zero exit or a timeout is a failure with a reason", () => {
  const failing = delegationHerdr({ panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]), exitCode: 1 });
  const failed = delegate({ ...input(), run: failing.run });
  assert.equal(failed.kind, DelegateOutcome.Failed);
  assert.ok(failed.kind === DelegateOutcome.Failed && failed.reason.includes("exited with code 1"));
  assert.ok(failed.kind === DelegateOutcome.Failed && failed.tail.includes("scripts/lib/herdr.ts:120"));

  const slow = delegationHerdr({ panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]), timeout: true });
  const timedOut = delegate({ ...input(), run: slow.run });
  assert.ok(
    timedOut.kind === DelegateOutcome.Failed &&
      timedOut.reason.includes("still running in pane boomerang-codebase-scout"),
  );
});

test("the model list is cached for ten minutes", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  let lists = 0;
  const listModels = () => {
    lists++;
    return "openrouter/deepseek/deepseek-v4.1-flash\nopenrouter/other/model\n";
  };
  const check = (model: string, now: number) => modelAvailability(model, dataDir, now, listModels);
  assert.deepEqual(check("openrouter/deepseek/deepseek-v4.1-flash", 1000), { kind: ModelCheck.Available });
  assert.equal(check("vercel/missing/model", 1300).kind, ModelCheck.Unavailable);
  assert.equal(lists, 1);
  check("openrouter/other/model", 1000 + 601);
  assert.equal(lists, 2);
});

test("missing OpenCode is reported as such", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const missing = () => {
    throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
  };
  const result = modelAvailability("a/b", dataDir, 1, missing);
  assert.deepEqual(result, {
    kind: ModelCheck.Unavailable,
    reason: "OpenCode is not installed (no `opencode` command)",
  });
});

test("the typed pane command works in a real shell: task text intact, report written, exit code in the done line", () => {
  const bin = mkdtempSync(join(tmpdir(), "boomerang-bin-"));
  writeFileSync(
    join(bin, "opencode"),
    '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\nprintf "\\033[1mbold\\033[0m\\n"\nexit 3\n',
    { mode: 0o755 },
  );
  const tricky = `Find "it" in O'Reilly's code; cost $HOME and \`date\` stay literal`;
  const herdr = delegationHerdr({ panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]) });
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  delegate({ ...input({ task: tricky, dataDir }), run: herdr.run });

  const out = execSync(herdr.command(), { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
  const id = / DONE ([0-9a-f]+) /.exec(herdr.command())?.[1];
  assert.match(out, new RegExp(`BOOMERANG_DONE:${id}:3`));
  assert.ok(out.includes(`[${tricky}]`), out);
  const reportFile = readdirSync(join(dataDir, "delegations")).find((f) => f.endsWith(".md")) ?? "";
  const report = readFileSync(join(dataDir, "delegations", reportFile), "utf8");
  assert.ok(report.includes(`[${tricky}]`));
  assert.ok(report.includes("[--agent]") && report.includes("[codebase-scout]"));
  assert.ok(report.includes(`[--]\n[${tricky}]`), "the task comes after --, so a leading dash is not a flag");
});

test("a pane claimed by a running delegation is not reused, even when it looks free", () => {
  const herdr = delegationHerdr({ panes: panesWith([["w2:p4", "boomerang-codebase-scout"]]) });
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  mkdirSync(join(dataDir, "pane-locks", "w2_p4"), { recursive: true }); // another delegation holds w2:p4
  const result = delegate({ ...input({ dataDir }), run: herdr.run });
  assert.equal(result.kind, DelegateOutcome.Done);
  const [paneRun] = herdr.calls.filter((c) => c.args[1] === "run");
  assert.equal(paneRun.args[2], "w2:p5", "a new pane was opened");
  assert.equal(existsSync(join(dataDir, "pane-locks", "w2_p5")), false, "the claim is released after the wait");
  assert.equal(existsSync(join(dataDir, "pane-locks", "w2_p4")), true, "someone else's claim is left alone");
});

test("delegation files older than seven days are removed; newer ones stay", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const dir = join(dataDir, "delegations");
  mkdirSync(dir);
  const day = 24 * 3600 * 1000;
  const now = 100 * day;
  writeFileSync(join(dir, `${now - 8 * day}-codebase-scout-aa.task.txt`), "old task");
  writeFileSync(join(dir, `${now - 8 * day}-codebase-scout-aa.md`), "old report");
  writeFileSync(join(dir, `${now - 1 * day}-log-digger-bb.md`), "new report");
  writeFileSync(join(dir, "not-ours.txt"), "keep");
  pruneDelegations(dataDir, now);
  assert.deepEqual(readdirSync(dir).sort(), [`${now - 1 * day}-log-digger-bb.md`, "not-ours.txt"]);
  pruneDelegations(join(dataDir, "missing"), now); // no folder: nothing to do, no error
});

test("when Herdr cannot be reached before anything is typed, the delegation runs headless instead", () => {
  const { run } = fakeHerdr([
    [["pane", "list"], { errorJson: '{"error":{"code":"server_unavailable","message":"no herdr server is running"}}' }],
  ]);
  const headless: Headless = () => ({ code: 0, output: "scripts/lib/names.ts:14\n", timedOut: false });
  const result = delegate({ ...input({ headless }), run });
  assert.deepEqual(result, { kind: DelegateOutcome.Done, report: "scripts/lib/names.ts:14\n" });
});
