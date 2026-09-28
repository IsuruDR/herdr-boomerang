// The hand-off step that Stop and StopFailure share: build the text, dispatch it, and only
// then mark the session as handed off, so a failed dispatch is tried again at the next stop.
// A lock file covers the one case where that is wrong: the hook was killed (timeout) in the
// middle of a dispatch, after the pane and the runner may already exist.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detachedSpawn, handOff } from "./dispatch.ts";
import { fallbackHandoff, gitStatus, recentUserPrompts } from "./handoff.ts";
import { herdrRunner, type Runner } from "./herdr.ts";
import type { HookContext } from "./hook-context.ts";
import { pluginRoot } from "./hook-context.ts";
import { Phase, saveState, writeJsonAtomic } from "./state.ts";

/** Each Herdr call in a hook gets 3 s, so about 8 calls stay well inside the hook timeout. */
const HOOK_HERDR_TIMEOUT_MS = 3000;
const hookRunner: Runner = (args, opts) => herdrRunner(args, { timeoutMs: opts?.timeoutMs ?? HOOK_HERDR_TIMEOUT_MS });

/** Claude could not write a handoff: build one from its transcript and the git state. */
export function transcriptHandoff(ctx: HookContext): string {
  const transcript = typeof ctx.input.transcript_path === "string" ? ctx.input.transcript_path : "(no transcript path)";
  return fallbackHandoff(transcript, recentUserPrompts(transcript), gitStatus(ctx.cwd));
}

function lockPath(ctx: HookContext): string {
  return join(ctx.dataDir, "state", `${ctx.sessionId}.dispatching`);
}

/** The resetAfter of an earlier dispatch that never finished, if its window is still open. */
function interruptedDispatch(ctx: HookContext): number | undefined {
  if (!existsSync(lockPath(ctx))) return undefined;
  try {
    const { resetAfter } = JSON.parse(readFileSync(lockPath(ctx), "utf8"));
    return typeof resetAfter === "number" && ctx.now < resetAfter ? resetAfter : undefined;
  } catch {
    return undefined;
  }
}

/** Dispatches the handoff and records the new phase. Returns the message for the user. */
export function dispatchHandoff(ctx: HookContext, text: string, resetAfter: number): string {
  const earlier = interruptedDispatch(ctx);
  if (earlier !== undefined) {
    saveState(ctx.dataDir, ctx.sessionId, { phase: Phase.HandedOff, resetAfter: earlier });
    rmSync(lockPath(ctx), { force: true });
    return [
      "boomerang: an earlier handoff was interrupted, so it is not started again.",
      `Its files are in ${join(ctx.dataDir, "handoffs")}. Look for a boomerang-codex pane in Herdr.`,
    ].join(" ");
  }

  writeJsonAtomic(lockPath(ctx), { resetAfter, startedAt: ctx.now });
  try {
    const message = handOff({
      text,
      handoffId: `${ctx.sessionId}-${ctx.now}`,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      options: ctx.options,
      dataDir: ctx.dataDir,
      env: process.env,
      run: hookRunner,
      spawn: detachedSpawn,
      pluginRoot: pluginRoot(process.env),
      resetAfter,
    });
    saveState(ctx.dataDir, ctx.sessionId, { phase: Phase.HandedOff, resetAfter });
    return message;
  } finally {
    rmSync(lockPath(ctx), { force: true });
  }
}
