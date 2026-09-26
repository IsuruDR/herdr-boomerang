// Per-session handoff phase, stored in the plugin data folder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const Phase = {
  Normal: "normal",
  Warned: "warned", // Claude was told to write a handoff
  HandedOff: "handed_off", // the handoff went to Codex (or to the user in notify mode)
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface SessionState {
  phase: Phase;
  resetAfter: number; // epoch seconds; after this, all windows that caused the handoff have reset
}

export const NORMAL_STATE: SessionState = { phase: Phase.Normal, resetAfter: 0 };

const PHASES: readonly string[] = Object.values(Phase);

function statePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "state", `${sessionId}.json`);
}

export function loadState(dataDir: string, sessionId: string, now: number): SessionState {
  let state: SessionState;
  try {
    state = JSON.parse(readFileSync(statePath(dataDir, sessionId), "utf8"));
  } catch {
    return NORMAL_STATE;
  }
  if (!PHASES.includes(state.phase) || typeof state.resetAfter !== "number") return NORMAL_STATE;
  if (state.phase !== Phase.Normal && now >= state.resetAfter) return NORMAL_STATE;
  return state;
}

export function saveState(dataDir: string, sessionId: string, state: SessionState): void {
  writeJsonAtomic(statePath(dataDir, sessionId), state);
}

/** Writes text through a temp file and a rename, so a reader never sees half a file. `mode` keeps permissions. */
export function writeTextAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/** The atomic JSON write that settings.ts, statusline.ts and the state files use. */
export function writeJsonAtomic(path: string, payload: unknown, mode?: number): void {
  writeTextAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, mode);
}
