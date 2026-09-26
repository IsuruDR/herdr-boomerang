// Is a model available in OpenCode? `opencode models` lists only models of connected providers,
// so the gateway (OpenRouter, Vercel AI Gateway, ...) never matters to us: the model ID is enough.
// The list is slow to build, so it is cached in the data folder for ten minutes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./state.ts";

const CACHE_SECONDS = 600;

export const ModelCheck = {
  Available: "available",
  Unavailable: "unavailable", // definite: OpenCode is missing, or the model is not in its list
  Unknown: "unknown", // could not check this time (timeout, error): callers keep the current state
} as const;
export type ModelAvailability =
  | { kind: typeof ModelCheck.Available }
  | { kind: typeof ModelCheck.Unavailable; reason: string }
  | { kind: typeof ModelCheck.Unknown; reason: string };

/** Hooks and the delegate command have tight time budgets, so the check waits 5 s at most. */
export const listOpenCodeModels = (): string =>
  execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

function cachedModels(dataDir: string, now: number): string[] | undefined {
  try {
    const cache = JSON.parse(readFileSync(join(dataDir, "opencode-models.json"), "utf8"));
    return now - cache.at < CACHE_SECONDS && Array.isArray(cache.models) ? cache.models : undefined;
  } catch {
    return undefined;
  }
}

export function modelAvailability(
  model: string,
  dataDir: string,
  now: number,
  listModels: () => string = listOpenCodeModels,
): ModelAvailability {
  let models = cachedModels(dataDir, now);
  if (!models) {
    try {
      models = listModels()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { kind: ModelCheck.Unavailable, reason: "OpenCode is not installed (no `opencode` command)" };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: ModelCheck.Unknown, reason: `\`opencode models\` did not answer: ${detail}` };
    }
    writeJsonAtomic(join(dataDir, "opencode-models.json"), { at: now, models });
  }
  if (models.includes(model)) return { kind: ModelCheck.Available };
  return {
    kind: ModelCheck.Unavailable,
    reason: `model ${model} is not in \`opencode models\`. Connect its provider with /connect in OpenCode, or pick another cheap model in /config.`,
  };
}
