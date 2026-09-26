// Herdr CLI adapter. Every Herdr call in boomerang goes through here, so there is one place
// that knows the command syntax and the JSON shapes (recorded in tests/fixtures/herdr).
import { execFileSync } from "node:child_process";

export interface RunOptions {
  /** Milliseconds before we stop the process. 0 means no limit: long waits use Herdr's own --timeout. */
  timeoutMs?: number;
}

/** Runs `herdr <args>` and returns stdout. Throws HerdrError on failure. */
export type Runner = (args: string[], opts?: RunOptions) => string;

export class HerdrError extends Error {
  override name = "HerdrError";
  /** Herdr's error code, for example "agent_not_found", when Herdr printed one. */
  code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }

  static fromStderr(args: string[], stderr: string): HerdrError {
    try {
      const { error } = JSON.parse(stderr);
      return new HerdrError(`herdr ${args[0]} ${args[1]}: ${error.message}`, error.code);
    } catch {
      return new HerdrError(`herdr ${args.join(" ")} failed: ${stderr.trim() || "no output"}`);
    }
  }
}

export const herdrRunner: Runner = (args, opts) => {
  try {
    return execFileSync("herdr", args, { encoding: "utf8", timeout: opts?.timeoutMs ?? 10_000, stdio: "pipe" });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw HerdrError.fromStderr(args, stderr || String(error));
  }
};

// biome-ignore lint/suspicious/noExplicitAny: Herdr JSON; each caller reads the one path it needs
function result(run: Runner, args: string[], opts?: RunOptions): any {
  const stdout = run(args, opts);
  try {
    return JSON.parse(stdout).result;
  } catch {
    throw new HerdrError(`herdr ${args[0]} ${args[1]}: output is not JSON`);
  }
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) throw new HerdrError(`herdr output has no ${what}`);
  return value;
}

// --- Context ---------------------------------------------------------------------------

export interface HerdrContext {
  paneId: string;
  workspaceId: string;
}

/** Where the calling process runs in Herdr, or undefined outside Herdr. */
export function herdrContext(env: NodeJS.ProcessEnv): HerdrContext | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_WORKSPACE_ID) return undefined;
  return { paneId: env.HERDR_PANE_ID, workspaceId: env.HERDR_WORKSPACE_ID };
}

// --- Panes -----------------------------------------------------------------------------

export type Placement = "split" | "tab";

/** Opens a pane beside the caller (split) or in a new tab of the same workspace, labels it, returns its ID. */
export function openPane(ctx: HerdrContext, placement: Placement, cwd: string, label: string, run: Runner): string {
  const paneId =
    placement === "tab"
      ? required<string>(
          result(run, ["tab", "create", "--workspace", ctx.workspaceId, "--cwd", cwd, "--label", label, "--no-focus"])
            ?.root_pane?.pane_id,
          "root_pane.pane_id",
        )
      : required<string>(
          result(run, ["pane", "split", "--pane", ctx.paneId, "--direction", "right", "--cwd", cwd, "--no-focus"])?.pane
            ?.pane_id,
          "pane.pane_id",
        );
  run(["pane", "rename", paneId, label]);
  return paneId;
}

export function runInPane(paneId: string, command: string, run: Runner): void {
  run(["pane", "run", paneId, command]);
}

export const OutputWait = { Matched: "matched", TimedOut: "timed_out", PaneGone: "pane_gone" } as const;
export type OutputWaitResult =
  | { kind: typeof OutputWait.Matched; line: string }
  | { kind: typeof OutputWait.TimedOut }
  | { kind: typeof OutputWait.PaneGone };

/** Waits until a line in the pane matches `regex`. Herdr also searches the command line, so build markers from parts. */
export function waitForOutput(paneId: string, regex: string, timeoutMs: number, run: Runner): OutputWaitResult {
  try {
    const matched = result(run, ["pane", "wait-output", paneId, "--regex", regex, "--timeout", String(timeoutMs)], {
      timeoutMs: 0,
    });
    return { kind: OutputWait.Matched, line: required<string>(matched?.matched_line, "matched_line") };
  } catch (error) {
    if (error instanceof HerdrError && error.code === "timeout") return { kind: OutputWait.TimedOut };
    if (error instanceof HerdrError && error.code === "pane_not_found") return { kind: OutputWait.PaneGone };
    throw error;
  }
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh"]);

/** The names of the pane's foreground processes, for example ["zsh"] or ["opencode"]. */
function foregroundProcessNames(paneId: string, run: Runner): string[] {
  const processes: Array<{ name?: string }> =
    result(run, ["pane", "process-info", "--pane", paneId])?.process_info?.foreground_processes ?? [];
  return processes.map((p) => (p.name ?? "").replace(/^-/, "")); // login shells show as "-zsh"
}

/** True for `base` itself or `base-<n>`, the names freeName() hands out. */
function isNameInFamily(label: string, base: string): boolean {
  if (label === base) return true;
  const suffix = label.startsWith(`${base}-`) ? label.slice(base.length + 1) : "";
  return /^\d+$/.test(suffix);
}

/**
 * A pane in the caller's workspace labelled `base` (or `base-<n>`) that sits at a shell prompt,
 * so a new delegation can reuse it and keep its scrollback. `claim` must succeed too: two
 * delegations that start at the same moment would otherwise pick the same idle pane.
 * Undefined when none is free.
 */
export function findFreePane(
  ctx: HerdrContext,
  base: string,
  run: Runner,
  claim: (paneId: string) => boolean = () => true,
): string | undefined {
  const panes: Array<{ pane_id: string; label?: string }> =
    result(run, ["pane", "list", "--workspace", ctx.workspaceId])?.panes ?? [];
  for (const pane of panes) {
    if (!pane.label || !isNameInFamily(pane.label, base)) continue;
    const names = foregroundProcessNames(pane.pane_id, run);
    if (names.length > 0 && names.every((name) => SHELLS.has(name)) && claim(pane.pane_id)) return pane.pane_id;
  }
  return undefined;
}

export function listPaneLabels(workspaceId: string, run: Runner): string[] {
  const panes: Array<{ label?: string }> = result(run, ["pane", "list", "--workspace", workspaceId])?.panes ?? [];
  return panes.map((pane) => pane.label).filter((label) => typeof label === "string");
}

export function closePane(paneId: string, run: Runner): void {
  run(["pane", "close", paneId]);
}

export function notify(title: string, body: string, run: Runner): void {
  run(["notification", "show", title, "--body", body, "--sound", "request"]);
}

/** A notification that can fail without stopping the step after it. */
export function safeNotify(title: string, body: string, run: Runner): void {
  try {
    notify(title, body, run);
  } catch {
    // Herdr could not show it; the caller goes on.
  }
}

// --- Agents ----------------------------------------------------------------------------

/**
 * "not found" covers both a pane with no agent and a closed pane: Herdr returns
 * agent_not_found for both, and for a name target both mean the agent is gone.
 */
export const AgentStatus = { NotFound: "not_found" } as const;

const AGENT_GONE_CODES = new Set(["agent_not_found", "agent_not_running"]);

function isAgentGone(error: unknown): boolean {
  return error instanceof HerdrError && error.code !== undefined && AGENT_GONE_CODES.has(error.code);
}

/** The agent's Herdr state (idle, working, blocked, done, unknown), or AgentStatus.NotFound. */
export function agentStatus(target: string, run: Runner): string {
  try {
    return required<string>(result(run, ["agent", "get", target])?.agent?.agent_status, "agent.agent_status");
  } catch (error) {
    if (isAgentGone(error)) return AgentStatus.NotFound;
    throw error;
  }
}

/** The agent's name, or undefined when it has none. Throws HerdrError when there is no agent. */
export function agentName(target: string, run: Runner): string | undefined {
  const name = result(run, ["agent", "get", target])?.agent?.name;
  return typeof name === "string" && name ? name : undefined;
}

export function listAgentNames(run: Runner): string[] {
  const agents: Array<{ name?: string }> = result(run, ["agent", "list"])?.agents ?? [];
  return agents.map((agent) => agent.name).filter((name) => typeof name === "string");
}

const START_TIMEOUT_MS = 60_000;

/** Starts an agent in a pane at a shell prompt. Returns when Herdr sees it ready for input. */
export function startAgent(name: string, kind: string, paneId: string, nativeArgs: string[], run: Runner): void {
  run(
    [
      "agent",
      "start",
      name,
      "--kind",
      kind,
      "--pane",
      paneId,
      "--timeout",
      String(START_TIMEOUT_MS),
      "--",
      ...nativeArgs,
    ],
    { timeoutMs: START_TIMEOUT_MS + 10_000 },
  );
}

export function renameAgent(target: string, name: string, run: Runner): void {
  run(["agent", "rename", target, name]);
}

/** Sends a prompt and returns at once. */
export function promptAgent(target: string, text: string, run: Runner): void {
  run(["agent", "prompt", target, text]);
}

export const PromptOutcome = {
  Stalled: "stalled", // no activity within Herdr's 5 s window; the prompt may still have arrived
  NotRunning: "not_running", // the agent exited, for example Codex failing right after start
} as const;

/** Sends a prompt and waits until the agent settles. Returns its state (done, idle, blocked) or a PromptOutcome. */
export function promptAndWait(target: string, text: string, run: Runner): string {
  try {
    return required<string>(
      result(run, ["agent", "prompt", target, text, "--wait"], { timeoutMs: 0 })?.agent?.agent_status,
      "agent.agent_status",
    );
  } catch (error) {
    if (error instanceof HerdrError && error.code === "agent_prompt_stalled") return PromptOutcome.Stalled;
    if (isAgentGone(error)) return PromptOutcome.NotRunning;
    throw error;
  }
}

/** Waits with no limit until the agent is done or idle. Returns the state, or AgentStatus.NotFound. */
export function waitUntilFinished(target: string, run: Runner): string {
  try {
    return required<string>(
      result(run, ["agent", "wait", target, "--until", "done", "--until", "idle"], { timeoutMs: 0 })?.agent
        ?.agent_status,
      "agent.agent_status",
    );
  } catch (error) {
    if (isAgentGone(error)) return AgentStatus.NotFound;
    throw error;
  }
}
