// Pure decisions for the background runner. Herdr does the waiting; this decides what comes next.
import { PromptOutcome } from "./herdr.ts";

// --- Gate result line ------------------------------------------------------------------
// The confirm screen prints "<marker>:<id>:start|cancel". The marker is joined from parts,
// so no source file and no command line on the screen ever holds it in full: Herdr's
// wait-output also searches the command line, and a literal marker would match itself.
const GATE_MARKER = ["BOOMERANG", "GATE"].join("_");

export const GateResult = { Start: "start", Cancel: "cancel" } as const;
export type GateResult = (typeof GateResult)[keyof typeof GateResult];

export function gateLine(gateId: string, result: GateResult): string {
  return `${GATE_MARKER}:${gateId}:${result}`;
}

/** The regex the runner passes to `herdr pane wait-output`. */
export function gateResultRegex(gateId: string): string {
  return `${GATE_MARKER}:${gateId}:(start|cancel)`;
}

/** The gate result in `text`, or undefined when it has none for this gate. */
export function gateResult(text: string, gateId: string): GateResult | undefined {
  const match = new RegExp(gateResultRegex(gateId)).exec(text);
  return match ? (match[1] as GateResult) : undefined;
}

// --- After each Herdr wait -------------------------------------------------------------

export const Next = {
  Finished: "finished",
  WaitForUser: "wait_for_user", // Codex asked a question: notify once, then agent wait
  CheckOnce: "check_once", // prompt stalled: read the state once before anything else
  ResendOnce: "resend_once", // stalled and Codex is idle: the text was lost (typed before Codex could take it)
  RetryWithoutDaemon: "retry_without_daemon", // Codex exited at start: try once more with --no-daemon
  GiveUp: "give_up",
} as const;
export type Next = (typeof Next)[keyof typeof Next];

export const HandBack = { PromptClaude: "prompt_claude", NotifyOnly: "notify_only" } as const;
export type HandBack = (typeof HandBack)[keyof typeof HandBack];

const READY_FOR_INPUT = new Set<string>(["idle", "done"]);

/**
 * `outcome` is what promptAndWait returned: a Herdr state or a PromptOutcome.
 * `retriedWithoutDaemon` is true once Codex already ran with --no-daemon.
 */
export function afterPrompt(outcome: string, retriedWithoutDaemon: boolean): Next {
  if (outcome === PromptOutcome.Stalled) return Next.CheckOnce;
  if (outcome === PromptOutcome.NotRunning) return retriedWithoutDaemon ? Next.GiveUp : Next.RetryWithoutDaemon;
  if (outcome === "blocked") return Next.WaitForUser;
  return READY_FOR_INPUT.has(outcome) ? Next.Finished : Next.GiveUp;
}

/**
 * After Herdr reported a stall. A working or blocked Codex got the prompt: never send it again.
 * An idle Codex with nothing started lost it (seen in the end-to-end run: `agent start` reports
 * ready a moment before Codex's input takes text), so it gets exactly one re-send.
 */
export function afterStalledCheck(status: string, alreadyResent: boolean): Next {
  if (status === "working" || status === "blocked") return Next.WaitForUser;
  if ((status === "idle" || status === "done") && !alreadyResent) return Next.ResendOnce;
  return Next.GiveUp;
}

export function handBackAction(handBack: boolean, claudeStatus: string): HandBack {
  return handBack && READY_FOR_INPUT.has(claudeStatus) ? HandBack.PromptClaude : HandBack.NotifyOnly;
}
