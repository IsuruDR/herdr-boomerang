// Entry: `run.mjs setup <plugin root> <data dir>`, run by /boomerang:setup.
// A plugin cannot set the main status line, and the status line is the only place with live
// rate-limit usage, so this one-time step points settings.json at our launcher. Any status
// line the user already had keeps working: we save it to chain.json and run it after ours.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, sync } from "../lib/external.ts";
import { describeSync, policyOf } from "../lib/external-report.ts";
import { optionsFromSettings } from "../lib/hook-io.ts";
import { installLauncher, statusLineCommand } from "../lib/launcher.ts";
import { modelAvailability } from "../lib/models.ts";
import { installStatusLine, PLUGIN_ID, pluginOptions, SETTINGS_PATH } from "../lib/settings.ts";

export function runSetup(pluginRoot: string, dataDir: string, settingsPath: string): string {
  installLauncher(pluginRoot, dataDir);
  const command = statusLineCommand(dataDir);
  const result = installStatusLine(settingsPath, command);
  if (result.kind === "already_installed") {
    return `boomerang: the status line already runs boomerang (${command}). Nothing changed.`;
  }
  const lines = [`boomerang: the status line now runs ${command}.`];
  const previousCommand = result.previous?.command;
  if (previousCommand) {
    writeFileSync(join(dataDir, "chain.json"), `${JSON.stringify({ command: previousCommand })}\n`);
    lines.push(`Your previous status line (${previousCommand}) still runs after it, and its output is what you see.`);
  } else {
    lines.push("It shows your 5-hour, 7-day and context usage.");
  }
  lines.push("boomerang reads the usage limits from it. To undo, set statusLine back in ~/.claude/settings.json.");
  return lines.join("\n");
}

export async function main(args: string[]): Promise<number> {
  const [pluginRoot, dataDir] = args;
  if (!pluginRoot || !dataDir) {
    process.stderr.write("usage: run.mjs setup <plugin root> <data dir>\n");
    return 1;
  }
  process.stdout.write(`${runSetup(pluginRoot, dataDir, SETTINGS_PATH)}\n`);
  const options = optionsFromSettings(pluginOptions(SETTINGS_PATH, PLUGIN_ID));
  const result = sync(defaultPaths(dataDir, pluginRoot), policyOf(options), () =>
    modelAvailability(options.cheapModel, dataDir, Math.floor(Date.now() / 1000)),
  );
  const report = describeSync(result);
  process.stdout.write(`${report ? `\nCheap-model agents:\n${report}` : "\nCheap-model agents: nothing to change."}\n`);
  return 0;
}
