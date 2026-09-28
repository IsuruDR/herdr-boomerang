// The status line is boomerang's sensor: it is the only place where Claude Code shows live
// rate-limit usage. We record the usage for the hooks, then print a line: the user's old
// status line when there was one (chain.json), or a short default.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./state.ts";
import { isSafeSessionId, usagePath, WINDOW_NAMES } from "./usage.ts";

// biome-ignore lint/suspicious/noExplicitAny: the status line JSON is owned by Claude Code
type StatusPayload = Record<string, any>;

function hasWindowFields(window: unknown): window is { used_percentage: number; resets_at: number } {
  if (typeof window !== "object" || window === null) return false;
  const { used_percentage: pct, resets_at: resetsAt } = window as Record<string, unknown>;
  return typeof pct === "number" && typeof resetsAt === "number";
}

/** Writes usage/<session_id>.json when the payload has rate limits. API-key sessions have none. */
export function recordUsage(payload: StatusPayload, dataDir: string): void {
  const sessionId = payload.session_id;
  const limits = payload.rate_limits;
  if (!isSafeSessionId(sessionId) || typeof limits !== "object" || limits === null) return;

  const snapshot: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
  for (const name of WINDOW_NAMES) {
    const window = limits[name];
    if (hasWindowFields(window))
      snapshot[name] = { used_percentage: window.used_percentage, resets_at: window.resets_at };
  }
  if (Object.keys(snapshot).length > 1) writeJsonAtomic(usagePath(dataDir, sessionId), snapshot);
}

function chainedCommand(dataDir: string): string | undefined {
  try {
    const { command } = JSON.parse(readFileSync(join(dataDir, "chain.json"), "utf8"));
    return typeof command === "string" && command ? command : undefined;
  } catch {
    return undefined;
  }
}

function percentPart(label: string, value: unknown): string | undefined {
  return typeof value === "number" ? `${label} ${Math.round(value)}%` : undefined;
}

function defaultLine(payload: StatusPayload): string {
  return [
    percentPart("5h", payload.rate_limits?.five_hour?.used_percentage),
    percentPart("7d", payload.rate_limits?.seven_day?.used_percentage),
    percentPart("ctx", payload.context_window?.used_percentage),
  ]
    .filter((part) => part !== undefined)
    .join(" | ");
}

function parsePayload(raw: string): StatusPayload {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** The line to print. Runs the user's old status line with the same input when there is one. */
export function render(raw: string, dataDir: string): string {
  const command = chainedCommand(dataDir);
  if (command) {
    try {
      return execSync(command, { input: raw, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      // The old status line failed: show ours instead of a blank line.
    }
  }
  return `${defaultLine(parsePayload(raw))}\n`;
}

/** Records usage, then returns the line. Never throws: a crash would blank the status line. */
export function statusLine(raw: string, dataDir: string): string {
  try {
    recordUsage(parsePayload(raw), dataDir);
  } catch {
    // Recording is best effort; the line still prints.
  }
  return render(raw, dataDir);
}
