// Hands the work off: saves the handoff, then sets up Herdr (a boomerang-codex pane, a name
// for Claude, the confirm screen) and starts the background runner. Falls back to a
// "notify" message when Herdr is not there or fails.
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexPrompt, reportPath, saveHandoff } from "./handoff.ts";
import {
  agentName,
  closePane,
  type HerdrContext,
  HerdrError,
  herdrContext,
  listAgentNames,
  listPaneLabels,
  openPane,
  type Runner,
  renameAgent,
  runInPane,
  safeNotify,
} from "./herdr.ts";
import { type Options, SwitchMode } from "./hook-io.ts";
import { boomerangName, freeName } from "./names.ts";
import { shellQuote, splitArgs } from "./shell.ts";

/** Starts a detached background process. Injected so tests never start real processes. */
export type Spawn = (command: string, args: string[]) => void;

export const detachedSpawn: Spawn = (command, args) => {
  spawnProcess(command, args, { detached: true, stdio: "ignore" }).unref();
};

export interface HandOffInput {
  text: string;
  /** Unique per handoff (session id plus time), so a second handoff never meets the first one's report. */
  handoffId: string;
  sessionId: string;
  cwd: string;
  options: Options;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  run: Runner;
  spawn: Spawn;
  pluginRoot: string;
  resetAfter: number;
}

/** Saves the handoff and hands it to Codex. Returns the message for the user. Never throws for Herdr problems. */
export function handOff(input: HandOffInput): string {
  const handoffPath = saveHandoff(input.dataDir, input.handoffId, input.text);
  const promptPath = join(dirname(handoffPath), `${input.handoffId}.prompt.txt`);
  writeFileSync(promptPath, codexPrompt(handoffPath, input.cwd));

  if (input.options.switchMode === SwitchMode.Notify) return manualMessage(handoffPath, promptPath, input.cwd);
  const badArgs = invalidCodexArgs(input.options.codexArgs);
  if (badArgs)
    return manualMessage(handoffPath, promptPath, input.cwd, `Extra Codex arguments are not valid (${badArgs})`);
  const ctx = herdrContext(input.env);
  if (!ctx) return manualMessage(handoffPath, promptPath, input.cwd, "Claude is not running inside Herdr");

  try {
    return startInHerdr(ctx, handoffPath, input);
  } catch (error) {
    if (!(error instanceof HerdrError)) throw error;
    return manualMessage(handoffPath, promptPath, input.cwd, `Herdr failed (${error.message})`);
  }
}

function startInHerdr(ctx: HerdrContext, handoffPath: string, input: HandOffInput): string {
  const { run, options } = input;
  const claudeName = ensureClaudeName(ctx.paneId, run);
  const codexName = freeName(boomerangName("codex"), [...listAgentNames(run), ...listPaneLabels(ctx.workspaceId, run)]);
  const codexPane = openPane(ctx, options.placement, input.cwd, codexName, run);
  const gateId = randomBytes(4).toString("hex");
  const runMjs = join(input.pluginRoot, "scripts", "run.mjs");

  try {
    if (options.switchMode === SwitchMode.Confirm) {
      runInPane(codexPane, gateCommand(runMjs, gateId, handoffPath), run);
    }
    input.spawn(process.execPath, [
      "--no-warnings",
      runMjs,
      "runner",
      ...["--data-dir", input.dataDir],
      ...["--session", input.sessionId],
      ...["--codex-pane", codexPane],
      ...["--codex-name", codexName],
      ...["--claude-name", claudeName ?? ""],
      ...["--handoff", handoffPath],
      ...["--cwd", input.cwd],
      ...["--mode", options.switchMode],
      ...["--gate-id", gateId],
      ...["--reset-after", String(input.resetAfter)],
      ...["--hand-back", options.handBack ? "1" : "0"],
      ...["--codex-args", options.codexArgs],
    ]);
  } catch (error) {
    closePaneQuietly(codexPane, run); // no empty pane, and no gate that nobody waits for
    throw error;
  }
  safeNotify("Claude is near its usage limit", `Codex is ready in pane ${codexName}`, run);
  const next = options.switchMode === SwitchMode.Confirm ? "confirm in that pane to start it" : "it starts now";
  const back = claudeName
    ? `Claude is ${claudeName} for the hand-back.`
    : "Herdr does not see Claude as an agent, so you get a notification instead of a hand-back.";
  return `boomerang: handoff saved. Codex is in pane ${codexName}; ${next}. ${back}`;
}

/**
 * Claude keeps its own name when it has one. Otherwise it gets a free boomerang-claude name,
 * because a name follows the agent when its pane moves, and a pane ID does not.
 * Undefined when Herdr does not see an agent in Claude's pane: the handoff still goes on.
 */
function ensureClaudeName(claudePane: string, run: Runner): string | undefined {
  let current: string | undefined;
  try {
    current = agentName(claudePane, run);
  } catch (error) {
    if (error instanceof HerdrError && error.code === "agent_not_found") return undefined;
    throw error;
  }
  if (current) return current;
  const name = freeName(boomerangName("claude"), listAgentNames(run));
  renameAgent(claudePane, name, run);
  return name;
}

function closePaneQuietly(paneId: string, run: Runner): void {
  try {
    closePane(paneId, run);
  } catch {
    // Best effort: the fallback message still tells the user what to do.
  }
}

/** The reason `codexArgs` cannot be split into arguments, or undefined when it can. */
function invalidCodexArgs(codexArgs: string): string | undefined {
  try {
    splitArgs(codexArgs);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The gate prints its result line itself, so this command never contains the marker the runner waits for. */
function gateCommand(runMjs: string, gateId: string, handoffPath: string): string {
  // process.execPath: the Node that runs this hook, which passed the version check. The pane's
  // own `node` can be older (nvm, asdf, volta), and then the gate would exit without a word.
  return [
    shellQuote(process.execPath),
    "--no-warnings",
    shellQuote(runMjs),
    "gate",
    "--id",
    gateId,
    "--handoff",
    shellQuote(handoffPath),
  ].join(" ");
}

function manualMessage(handoffPath: string, promptPath: string, cwd: string, reason?: string): string {
  const why = reason ? `${reason}, so Codex was not started. ` : "";
  return [
    `boomerang: handoff saved to ${handoffPath}. ${why}To continue in Codex, run:`,
    `  cd ${shellQuote(cwd)} && codex --add-dir ${shellQuote(dirname(handoffPath))} "$(cat ${shellQuote(promptPath)})"`,
    `Codex writes its report to ${reportPath(handoffPath)}.`,
  ].join("\n");
}
