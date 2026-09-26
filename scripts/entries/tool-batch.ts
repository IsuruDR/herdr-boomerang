// Entry: PostToolBatch hook. Warns Claude in the middle of a turn when usage crosses the threshold.
import { Action, onToolBatch } from "../lib/decide.ts";
import { instruction } from "../lib/handoff.ts";
import { resetAfterFor, runHook } from "../lib/hook-context.ts";
import { saveState } from "../lib/state.ts";

export function main(): Promise<number> {
  return runHook("tool-batch", (ctx) => {
    const decision = onToolBatch(ctx.state.phase, ctx.over.length > 0);
    if (decision.action !== Action.InjectInstruction) return undefined;
    saveState(ctx.dataDir, ctx.sessionId, {
      phase: decision.nextPhase,
      resetAfter: resetAfterFor(ctx.over, ctx.now, ctx.state.resetAfter),
    });
    return { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: instruction(ctx.over) } };
  });
}
