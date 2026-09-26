// Small helpers shared by /boomerang:external, setup and SessionStart.
import type { CheapModelPolicy } from "./agentdef.ts";
import type { SyncResult } from "./external.ts";
import type { Options } from "./hook-io.ts";

export function policyOf(options: Options): CheapModelPolicy {
  return { agents: options.cheapModelAgents, canEditFiles: options.cheapModelCanEditFiles };
}

/** A short text for the user, or "" when nothing changed and nothing went wrong. */
export function describeSync(result: SyncResult): string {
  const lines = [...result.changes];
  if (result.modelProblem) lines.push(`Cheap-model agents stay on Claude: ${result.modelProblem}`);
  lines.push(...result.skipped.map((s) => `Skipped ${s}`));
  return lines.join("\n");
}
