// Entry: StopFailure hook (matcher: rate_limit). The limit came before Claude could write a
// handoff, so we build one from the transcript. Claude Code ignores this hook's output except
// terminalSequence, so the user hears about it through Herdr or a desktop notification.
import { Action, onStopFailure } from "../lib/decide.ts";
import { herdrContext } from "../lib/herdr.ts";
import { resetAfterFor, runHook } from "../lib/hook-context.ts";
import { dispatchHandoff, transcriptHandoff } from "../lib/hook-handoff.ts";

/** OSC 9 desktop notification (iTerm2, WezTerm, Windows Terminal, Ghostty). Control characters are removed. */
function desktopNotification(text: string): string {
  const isControl = (char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
  const safe = Array.from(text, (char) => (isControl(char) ? " " : char))
    .join("")
    .slice(0, 200);
  return `\u001b]9;${safe}\u0007`;
}

export function main(): Promise<number> {
  return runHook("stop-failure", (ctx) => {
    const error = typeof ctx.input.error === "string" ? ctx.input.error : "";
    const decision = onStopFailure(ctx.state.phase, error);
    if (decision.action !== Action.HandOffTranscript) return undefined;

    const windows = ctx.over.length ? ctx.over : ctx.snapshot;
    dispatchHandoff(ctx, transcriptHandoff(ctx), resetAfterFor(windows, ctx.now, ctx.state.resetAfter));
    if (herdrContext(process.env)) return undefined; // Herdr already showed a notification
    return { terminalSequence: desktopNotification("boomerang: Claude hit its limit. The handoff is saved.") };
  });
}
