// Reads the rate-limit snapshot that the status line writes for each session.
// File format (shared with lib/statusline.ts through usagePath and UsageWindow):
// {"five_hour": {"used_percentage": 42, "resets_at": 1760000000}, "seven_day": {...}, "updated_at": 1759990000}
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOW_NAMES = ["five_hour", "seven_day"] as const;
export type WindowName = (typeof WINDOW_NAMES)[number];

export interface UsageWindow {
  name: WindowName;
  usedPercentage: number;
  resetsAt: number; // Unix epoch seconds
}

export type Thresholds = Record<WindowName, number>;

/** Session ids go into file names, so only plain ids are accepted (Claude Code uses UUIDs). */
export function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}

export function usagePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "usage", `${sessionId}.json`);
}

/** The windows in the snapshot, or undefined when no usable snapshot exists. */
export function readSnapshot(dataDir: string, sessionId: string): UsageWindow[] | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(usagePath(dataDir, sessionId), "utf8"));
  } catch {
    return undefined;
  }
  return WINDOW_NAMES.map((name) => parseWindow(name, raw[name])).filter((w) => w !== undefined);
}

function parseWindow(name: WindowName, value: unknown): UsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { used_percentage: usedPercentage, resets_at: resetsAt } = value as Record<string, unknown>;
  if (typeof usedPercentage !== "number" || typeof resetsAt !== "number") return undefined;
  return { name, usedPercentage, resetsAt };
}

/** Windows that have not reset yet and are at or above their threshold. */
export function windowsOverThreshold(
  snapshot: UsageWindow[] | undefined,
  thresholds: Thresholds,
  now: number,
): UsageWindow[] {
  return (snapshot ?? []).filter((w) => w.resetsAt > now && w.usedPercentage >= thresholds[w.name]);
}
