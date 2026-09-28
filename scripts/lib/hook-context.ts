// Shared setup for the three hooks: read the input, skip subagents, load the options, the
// usage snapshot and the session state. Also the wrapper that makes every hook safe: any
// error is logged and the hook exits 0, because a broken plugin must never block Claude.
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { dataDirFromEnv, type HookInput, isSubagent, type Options, optionsFromEnv, readHookInput } from "./hook-io.ts";
import { logError } from "./log.ts";
import { loadState, type SessionState } from "./state.ts";
import { isSafeSessionId, readSnapshot, type UsageWindow, windowsOverThreshold } from "./usage.ts";

const FALLBACK_WINDOW_SECONDS = 5 * 3600;

export interface HookContext {
  input: HookInput;
  dataDir: string;
  options: Options;
  sessionId: string;
  cwd: string;
  now: number;
  snapshot: UsageWindow[];
  over: UsageWindow[];
  state: SessionState;
}

/** The context for this hook call, or undefined when the hook should do nothing (subagent, no session). */
export function buildHookContext(rawInput: string, env: NodeJS.ProcessEnv, now: number): HookContext | undefined {
  const input = readHookInput(rawInput);
  if (isSubagent(input)) return undefined;
  const sessionId = input.session_id;
  if (!isSafeSessionId(sessionId)) return undefined;

  const dataDir = dataDirFromEnv(env);
  const options = optionsFromEnv(env);
  const snapshot = readSnapshot(dataDir, sessionId) ?? [];
  return {
    input,
    dataDir,
    options,
    sessionId,
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
    now,
    snapshot,
    over: windowsOverThreshold(snapshot, options.thresholds, now),
    state: loadState(dataDir, sessionId, now),
  };
}

/**
 * When the windows behind this handoff have all reset: the latest reset among `windows`.
 * With no window data, keep the saved value, or else assume a five-hour window.
 */
export function resetAfterFor(windows: UsageWindow[], now: number, saved: number): number {
  if (windows.length) return Math.max(...windows.map((w) => w.resetsAt));
  return saved > now ? saved : now + FALLBACK_WINDOW_SECONDS;
}

/** The plugin folder: CLAUDE_PLUGIN_ROOT, or two levels up from this file. */
export function pluginRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_PLUGIN_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
}

/** Runs a hook body with the stdin context. Prints its JSON result, if any. Always returns 0. */
export async function runHook(
  where: string,
  body: (ctx: HookContext) => Record<string, unknown> | undefined,
): Promise<number> {
  let dataDir: string | undefined = process.env.CLAUDE_PLUGIN_DATA;
  try {
    const ctx = buildHookContext(await text(process.stdin), process.env, Math.floor(Date.now() / 1000));
    if (!ctx) return 0;
    dataDir = ctx.dataDir;
    const output = body(ctx);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    logError(dataDir, where, error);
  }
  return 0;
}
