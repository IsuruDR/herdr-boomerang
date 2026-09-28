// Decides what each hook should do. No I/O, so every transition has a unit test.
import { Phase } from "./state.ts";

export const Action = {
  None: "none",
  InjectInstruction: "inject_instruction", // PostToolBatch additionalContext
  BlockStop: "block_stop", // Stop decision=block with the instruction
  HandOffSummary: "hand_off_summary", // use the handoff Claude wrote
  HandOffTranscript: "hand_off_transcript", // Claude could not write one; build it from the transcript
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

export function onStop(
  phase: Phase,
  overThreshold: boolean,
  replyHasHandoff: boolean,
  stopHookActive: boolean,
): Decision {
  if (phase === Phase.HandedOff) return stay(phase);
  if (phase === Phase.Normal) {
    return overThreshold ? { action: Action.BlockStop, nextPhase: Phase.Warned } : stay(phase);
  }
  // phase is Warned. stop_hook_active is true after any Stop hook blocked, ours or another
  // plugin's; after another plugin's block we fall back to the transcript without a reminder.
  // That costs one reminder at most, and it can never loop.
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
