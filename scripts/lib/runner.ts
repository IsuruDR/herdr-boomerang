// The background runner's steps, in order. Each wait is a Herdr command; the decisions
// come from handback.ts. Herdr, the clock and sleep are injected, so tests run it in
// milliseconds with the recorded Herdr output.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  afterPrompt,
  afterStalledCheck,
  GateResult,
  gateResult,
  gateResultRegex,
  HandBack,
  handBackAction,
  Next,
} from "./handback.ts";
import { codexPrompt, handBackPrompt, reportPath } from "./handoff.ts";
import {
  AgentStatus,
  agentStatus,
  OutputWait,
  promptAgent,
  promptAndWait,
  type Runner,
  safeNotify,
  startAgent,
  waitForOutput,
  waitUntilFinished,
} from "./herdr.ts";
import { splitArgs } from "./shell.ts";

const GATE_TIMEOUT_MS = 24 * 3600 * 1000;
const MAX_SLEEP_SECONDS = 600; // short steps, so a clock jump after the Mac wakes is noticed
const RESET_GRACE_SECONDS = 60;
const NO_DAEMON = "--no-daemon";
const CODEX_SETTLE_SECONDS = 3; // `agent start` says ready a moment before Codex's input takes text
/**
 * Codex must write files to continue the work, and --add-dir (for the report) needs a writable
 * sandbox too. A read-only default would make Codex exit at once, so we pick workspace-write
 * unless the user chose a sandbox in their Codex arguments.
 */
const DEFAULT_SANDBOX = ["--sandbox", "workspace-write"];
const SANDBOX_FLAGS = new Set(["-s", "--sandbox", "--dangerously-bypass-approvals-and-sandbox"]);
/**
 * Codex's "update available" screen looks ready to Herdr, so our prompt would answer it
 * (Enter picks "Update now"). This skips that screen for boomerang's Codex only; the
 * user's config.toml is not touched.
 */
const NO_UPDATE_PROMPT = ["-c", "check_for_update_on_startup=false"];
/**
 * Codex can install this plugin from a Claude marketplace. Then it asks the user to trust our
 * hooks before its input takes text, and our prompt lands on that screen. This turns the plugin
 * off for boomerang's Codex only. No quotes around the ID: Codex keeps them as part of the key.
 */
const NO_BOOMERANG_PLUGIN = ["-c", "plugins.boomerang@boomerang.enabled=false"];

export interface RunnerConfig {
  dataDir: string;
  codexPane: string;
  codexName: string;
  claudeName: string;
  handoffPath: string;
  cwd: string;
  mode: string;
  gateId: string;
  resetAfter: number;
  handBack: boolean;
  codexArgs: string;
}

export interface RunnerDeps {
  run: Runner;
  now: () => number; // epoch seconds
  sleep: (seconds: number) => Promise<void>;
  fileExists?: (path: string) => boolean;
}

export async function runHandoff(cfg: RunnerConfig, deps: RunnerDeps): Promise<void> {
  if (cfg.mode === "confirm" && !userConfirmed(cfg, deps.run)) return;
  const codexFinished = await startAndDriveCodex(cfg, deps);
  const report = reportPath(cfg.handoffPath);
  const fileExists = deps.fileExists ?? existsSync;
  if (codexFinished) {
    const detail = fileExists(report) ? `Report: ${report}` : "Codex wrote no report.";
    safeNotify("Codex finished", detail, deps.run);
  }
  await sleepUntil(cfg.resetAfter + RESET_GRACE_SECONDS, deps);
  handBackToClaude(cfg, deps.run, report, fileExists(report));
}

/** Waits for the confirm screen's result line. False on cancel, timeout or a closed pane. */
function userConfirmed(cfg: RunnerConfig, run: Runner): boolean {
  const wait = waitForOutput(cfg.codexPane, gateResultRegex(cfg.gateId), GATE_TIMEOUT_MS, run);
  return wait.kind === OutputWait.Matched && gateResult(wait.line, cfg.gateId) === GateResult.Start;
}

/** Codex failing to start must not cost Claude its hand-back, so every error ends here as "not finished". */
async function startAndDriveCodex(cfg: RunnerConfig, deps: RunnerDeps): Promise<boolean> {
  try {
    return await driveCodex(cfg, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    safeNotify("Codex could not start", `${reason}. Claude gets the work back after its limit resets.`, deps.run);
    return false;
  }
}

/** Starts Codex, gives it the handoff, and waits. True when Codex finished; false when it gave up. */
async function driveCodex(cfg: RunnerConfig, deps: RunnerDeps): Promise<boolean> {
  const { run } = deps;
  const userArgs = splitArgs(cfg.codexArgs);
  const sandboxArgs = userArgs.some((arg) => SANDBOX_FLAGS.has(arg.split("=")[0])) ? [] : DEFAULT_SANDBOX;
  let withoutDaemon = userArgs.includes(NO_DAEMON);
  let resent = false;
  const start = async (extraArgs: string[]) => {
    startAgent(
      cfg.codexName,
      "codex",
      cfg.codexPane,
      [
        "--add-dir",
        dirname(cfg.handoffPath),
        ...sandboxArgs,
        ...NO_UPDATE_PROMPT,
        ...NO_BOOMERANG_PLUGIN,
        ...userArgs,
        ...extraArgs,
      ],
      run,
    );
    await deps.sleep(CODEX_SETTLE_SECONDS);
  };

  await start([]);
  for (;;) {
    const outcome = promptAndWait(cfg.codexName, codexPrompt(cfg.handoffPath, cfg.cwd), run);
    let next = afterPrompt(outcome, withoutDaemon);
    if (next === Next.CheckOnce) {
      next = afterStalledCheck(agentStatus(cfg.codexName, run), resent);
    }
    if (next === Next.Finished) return true;
    if (next === Next.RetryWithoutDaemon) {
      withoutDaemon = true;
      await start([NO_DAEMON]);
      continue;
    }
    if (next === Next.ResendOnce) {
      resent = true;
      await deps.sleep(CODEX_SETTLE_SECONDS);
      continue;
    }
    if (next === Next.WaitForUser) return waitForUser(cfg, run);
    safeNotify(
      "Codex stopped",
      `Codex did not finish in pane ${cfg.codexName}. Look at that pane for the reason.`,
      run,
    );
    return false;
  }
}

/** Codex asked something or is still busy: tell the user once, then wait with no limit. */
function waitForUser(cfg: RunnerConfig, run: Runner): boolean {
  safeNotify("Codex needs your answer", `Codex is waiting in pane ${cfg.codexName}.`, run);
  return waitUntilFinished(cfg.codexName, run) !== AgentStatus.NotFound;
}

async function sleepUntil(target: number, deps: RunnerDeps): Promise<void> {
  for (let remaining = target - deps.now(); remaining > 0; remaining = target - deps.now()) {
    await deps.sleep(Math.min(remaining, MAX_SLEEP_SECONDS));
  }
}

/**
 * Prompts Claude only when it is ready for input. We never type into a busy agent.
 * An empty claudeName means Herdr did not see Claude as an agent at handoff time: notify only.
 */
function handBackToClaude(cfg: RunnerConfig, run: Runner, report: string, reportExists: boolean): void {
  const claudeStatus = cfg.claudeName ? agentStatus(cfg.claudeName, run) : AgentStatus.NotFound;
  const action = handBackAction(cfg.handBack, claudeStatus);
  if (action === HandBack.PromptClaude) {
    promptAgent(cfg.claudeName, handBackPrompt(report, reportExists), run);
    return;
  }
  const why = cfg.handBack ? "Claude was busy or gone" : "Hand-back is off";
  safeNotify("Claude's limit has reset", `${why}, so read ${report} when you go back to Claude.`, run);
}
