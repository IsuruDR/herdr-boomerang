// Entry: SessionStart hook. Points the launcher at the current plugin version (the plugin
// folder changes on every update), applies the cheap-model rule to the agent files, reminds
// the user to run setup until the status line is connected, and says when config.json is invalid.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pruneDelegations } from "../lib/delegate.ts";
import { defaultPaths, sync } from "../lib/external.ts";
import { describeSync, policyOf } from "../lib/external-report.ts";
import { pluginRoot, runHook } from "../lib/hook-context.ts";
import { readAdvancedConfig, unknownAdvancedKeys } from "../lib/hook-io.ts";
import { installLauncher, statusLineCommand } from "../lib/launcher.ts";
import { modelAvailability } from "../lib/models.ts";
import { loadSettings, SETTINGS_PATH } from "../lib/settings.ts";
import { writeJsonAtomic } from "../lib/state.ts";

/** A model problem is worth saying once, not at every session start. When it goes away, we forget it. */
function isNewProblem(dataDir: string, problem: string | undefined): boolean {
  const path = join(dataDir, "notified.json");
  if (!problem) {
    rmSync(path, { force: true });
    return false;
  }
  try {
    if (JSON.parse(readFileSync(path, "utf8")).problem === problem) return false;
  } catch {
    // Not told yet.
  }
  writeJsonAtomic(path, { problem });
  return true;
}

export function main(): Promise<number> {
  return runHook("session-start", (ctx) => {
    const root = pluginRoot(process.env);
    installLauncher(root, ctx.dataDir);
    pruneDelegations(ctx.dataDir, Date.now());
    const messages: string[] = [];
    const advanced = readAdvancedConfig();
    if (advanced.kind === "invalid") {
      messages.push(`boomerang: ${advanced.reason}. The built-in defaults apply until you fix it.`);
    }
    const unknown = advanced.kind === "valid" ? unknownAdvancedKeys(advanced.values) : [];
    if (unknown.length) {
      messages.push(
        `boomerang: config.json has keys that boomerang does not read: ${unknown.join(", ")}. Check the spelling.`,
      );
    }
    if (loadSettings(SETTINGS_PATH).statusLine?.command !== statusLineCommand(ctx.dataDir)) {
      messages.push("boomerang: run /boomerang:setup once to connect the status line (it reads your usage limits).");
    }
    const result = sync(defaultPaths(ctx.dataDir, root), policyOf(ctx.options), () =>
      modelAvailability(ctx.options.cheapModel, ctx.dataDir, ctx.now),
    );
    const report = describeSync({
      ...result,
      modelProblem: isNewProblem(ctx.dataDir, result.modelProblem) ? result.modelProblem : undefined,
    });
    if (report) messages.push(`boomerang: ${report.replaceAll("\n", "\nboomerang: ")}`);
    return messages.length ? { systemMessage: messages.join("\n") } : undefined;
  });
}
