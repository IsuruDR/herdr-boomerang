// Runs one task on an OpenCode agent with the cheap model and returns its answer as text.
// In Herdr it runs in a reused `boomerang-<agent>` pane, so you can watch it; outside Herdr it
// runs headless. Called by the proxy subagents through `boomerang delegate <agent>`.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findFreePane,
  type HerdrContext,
  HerdrError,
  herdrContext,
  listPaneLabels,
  OutputWait,
  openPane,
  type Runner,
  runInPane,
  waitForOutput,
} from "./herdr.ts";
import type { Options } from "./hook-io.ts";
import type { ModelAvailability } from "./models.ts";
import { ModelCheck } from "./models.ts";
import { boomerangName, freeName } from "./names.ts";
import { shellQuote } from "./shell.ts";

const TAIL_LINES = 20;
const KEEP_DELEGATIONS_MS = 7 * 24 * 3600 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const DelegateOutcome = { Done: "done", Failed: "failed", Unavailable: "unavailable" } as const;
export type DelegateResult =
  | { kind: typeof DelegateOutcome.Done; report: string }
  | { kind: typeof DelegateOutcome.Failed; reason: string; tail: string }
  | { kind: typeof DelegateOutcome.Unavailable; reason: string };

/** Runs `opencode <args>` without a shell. Injected so tests never start OpenCode. */
export type Headless = (args: string[], timeoutMs: number) => { code: number; output: string; timedOut: boolean };

export const opencodeHeadless: Headless = (args, timeoutMs) => {
  try {
    const output = execFileSync("opencode", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output, timedOut: false };
  } catch (error) {
    const failure = error as { status?: number; signal?: string; code?: string; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      timedOut: failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM",
    };
  }
};

export interface DelegateInput {
  agent: string;
  task: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  options: Options;
  run: Runner;
  headless: Headless;
  checkModel: () => ModelAvailability;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(${BEL}|${ESC}\\\\)`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

/** `--` ends the options, so a task that starts with "-" is never read as a flag. */
function opencodeArgs(input: DelegateInput, task: string): string[] {
  return ["run", "--agent", input.agent, "-m", input.options.cheapModel, "--dir", input.cwd, "--", task];
}

/** Delegation files hold task text and answers; keep them a week for debugging, then remove them. */
export function pruneDelegations(dataDir: string, nowMs: number): void {
  const dir = join(dataDir, "delegations");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const startedAt = Number(/^(\d+)-/.exec(file)?.[1]);
    if (Number.isFinite(startedAt) && nowMs - startedAt > KEEP_DELEGATIONS_MS) rmSync(join(dir, file), { force: true });
  }
}

export function delegate(input: DelegateInput): DelegateResult {
  const check = input.checkModel();
  if (check.kind === ModelCheck.Unavailable) return { kind: DelegateOutcome.Unavailable, reason: check.reason };
  const ctx = herdrContext(input.env);
  return ctx ? delegateInHerdr(ctx, input) : delegateHeadless(input);
}

function delegateHeadless(input: DelegateInput): DelegateResult {
  const result = input.headless(opencodeArgs(input, input.task), input.options.delegateTimeoutSeconds * 1000);
  const output = stripAnsi(result.output);
  if (result.timedOut) {
    return {
      kind: DelegateOutcome.Failed,
      reason: `no answer within ${input.options.delegateTimeoutSeconds} s`,
      tail: tail(output),
    };
  }
  if (result.code !== 0) {
    return { kind: DelegateOutcome.Failed, reason: `opencode exited with code ${result.code}`, tail: tail(output) };
  }
  return { kind: DelegateOutcome.Done, report: output };
}

/**
 * A pane claim is a folder: mkdir either creates it or fails, even when two delegations race.
 * A claim older than the longest delegation is left over from a killed one and is taken over.
 */
interface PaneClaims {
  claim(paneId: string): boolean;
  release(paneId: string): void;
}

function paneClaims(input: DelegateInput): PaneClaims {
  const dir = join(input.dataDir, "pane-locks");
  const staleMs = (input.options.delegateTimeoutSeconds + 60) * 1000;
  const path = (paneId: string) => join(dir, paneId.replace(/[^A-Za-z0-9_-]/g, "_"));
  return {
    claim(paneId: string): boolean {
      mkdirSync(dir, { recursive: true });
      try {
        mkdirSync(path(paneId));
        return true;
      } catch {
        if (Date.now() - statSync(path(paneId)).mtimeMs < staleMs) return false;
        rmSync(path(paneId), { recursive: true, force: true });
        mkdirSync(path(paneId));
        return true;
      }
    },
    release(paneId: string): void {
      rmSync(path(paneId), { recursive: true, force: true });
    },
  };
}

/** Finds or opens a claimed pane. Undefined when Herdr cannot be reached: nothing was typed yet. */
function acquirePane(ctx: HerdrContext, label: string, input: DelegateInput, claims: PaneClaims): string | undefined {
  const { run } = input;
  try {
    const free = findFreePane(ctx, label, run, claims.claim);
    if (free) return free;
    const taken = listPaneLabels(ctx.workspaceId, run);
    const opened = openPane(ctx, input.options.placement, input.cwd, freeName(label, taken), run);
    claims.claim(opened);
    return opened;
  } catch (error) {
    if (error instanceof HerdrError) return undefined;
    throw error;
  }
}

function delegateInHerdr(ctx: HerdrContext, input: DelegateInput): DelegateResult {
  const label = boomerangName(input.agent);
  const claims = paneClaims(input);
  const paneId = acquirePane(ctx, label, input, claims);
  if (!paneId) return delegateHeadless(input); // Herdr is unreachable; the task never reached a pane
  try {
    return runInClaimedPane(paneId, label, input);
  } finally {
    claims.release(paneId);
  }
}

function runInClaimedPane(paneId: string, label: string, input: DelegateInput): DelegateResult {
  const { run } = input;

  const id = randomBytes(4).toString("hex");
  const dir = join(input.dataDir, "delegations");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${Date.now()}-${input.agent}-${id}`);
  const files = { task: `${base}.task.txt`, report: `${base}.md`, exit: `${base}.exit` };
  writeFileSync(files.task, input.task);
  writeFileSync(files.report, "");

  runInPane(paneId, paneCommand(input, id, files), run);
  const wait = waitForOutput(paneId, `BOOMERANG_DONE:${id}:(\\d+)`, input.options.delegateTimeoutSeconds * 1000, run);
  const report = stripAnsi(readFileSync(files.report, "utf8"));
  if (wait.kind === OutputWait.TimedOut) {
    return { kind: DelegateOutcome.Failed, reason: `still running in pane ${label}`, tail: tail(report) };
  }
  if (wait.kind === OutputWait.PaneGone) {
    return { kind: DelegateOutcome.Failed, reason: `pane ${label} was closed`, tail: tail(report) };
  }
  const code = Number(/:(\d+)$/.exec(wait.line)?.[1] ?? "1");
  if (code !== 0)
    return { kind: DelegateOutcome.Failed, reason: `opencode exited with code ${code}`, tail: tail(report) };
  return { kind: DelegateOutcome.Done, report };
}

/**
 * The command typed into the pane. `sh -c` makes it work whatever shell the pane runs (fish too).
 * The task comes from a file (no quoting problems), the output goes to the report and the screen,
 * and the done line is printed from parts: Herdr's wait-output also searches the command line on
 * the screen, so the full marker must never appear in the command itself.
 */
function paneCommand(input: DelegateInput, id: string, files: { task: string; report: string; exit: string }): string {
  const q = shellQuote;
  const opencode = [
    "opencode run --agent",
    q(input.agent),
    "-m",
    q(input.options.cheapModel),
    "--dir",
    q(input.cwd),
    "--",
    `"$(cat ${q(files.task)})"`,
  ].join(" ");
  const script = [
    `{ ${opencode} 2>&1; echo $? > ${q(files.exit)}; } | tee ${q(files.report)}`,
    // A missing exit file counts as a failure (1), so the done line always matches the wait regex.
    `printf 'BOOMERANG_%s:%s:%s\\n' DONE ${id} "$(cat ${q(files.exit)} 2>/dev/null || echo 1)"`,
  ].join("; ");
  return `sh -c ${q(script)}`;
}
