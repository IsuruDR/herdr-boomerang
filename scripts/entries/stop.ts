// Entry: Stop hook. Asks for the handoff, captures it from Claude's reply, or falls back to the transcript.
import { Action, onStop } from "../lib/decide.ts";
import { containsHandoff, extractHandoff, instruction } from "../lib/handoff.ts";
import { resetAfterFor, runHook } from "../lib/hook-context.ts";
import { dispatchHandoff, transcriptHandoff } from "../lib/hook-handoff.ts";
import { saveState } from "../lib/state.ts";

export function main(): Promise<number> {
  return runHook("stop", (ctx) => {
    const reply = typeof ctx.input.last_assistant_message === "string" ? ctx.input.last_assistant_message : "";
    const decision = onStop(
      ctx.state.phase,
      ctx.over.length > 0,
      containsHandoff(reply),
      ctx.input.stop_hook_active === true,
    );
    const resetAfter = resetAfterFor(ctx.over, ctx.now, ctx.state.resetAfter);

    if (decision.action === Action.BlockStop) {
      saveState(ctx.dataDir, ctx.sessionId, { phase: decision.nextPhase, resetAfter });
      return { decision: "block", reason: instruction(ctx.over) };
    }
    if (decision.action === Action.HandOffSummary) {
      return { systemMessage: dispatchHandoff(ctx, extractHandoff(reply), resetAfter) };
    }
    if (decision.action === Action.HandOffTranscript) {
      return { systemMessage: dispatchHandoff(ctx, transcriptHandoff(ctx), resetAfter) };
    }
    return undefined;
  });
}
