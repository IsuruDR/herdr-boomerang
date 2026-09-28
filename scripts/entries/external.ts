// Entry: `run.mjs external <list|sync|pin <agent> <claude|opencode|auto>> --data <dir>`,
// run by /boomerang:external. Not a hook, so the options come from settings.json.
import { parseArgs } from "node:util";
import { defaultPaths, listAgents, pin, sync } from "../lib/external.ts";
import { describeSync, policyOf } from "../lib/external-report.ts";
import { pluginRoot } from "../lib/hook-context.ts";
import { optionsFromSettings } from "../lib/hook-io.ts";
import { modelAvailability } from "../lib/models.ts";
import { PLUGIN_ID, pluginOptions, SETTINGS_PATH } from "../lib/settings.ts";

const PIN_TARGETS = ["claude", "opencode", "auto"] as const;

export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { data: { type: "string" } }, allowPositionals: true });
  const dataDir = values.data;
  if (!dataDir) {
    process.stdout.write("usage: run.mjs external <list|sync|pin <agent> <claude|opencode|auto>> --data <dir>\n");
    return 2;
  }
  const options = optionsFromSettings(pluginOptions(SETTINGS_PATH, PLUGIN_ID));
  const paths = defaultPaths(dataDir, pluginRoot(process.env));
  const checkModel = () => modelAvailability(options.cheapModel, dataDir, Math.floor(Date.now() / 1000));
  const [command, agent, target] = positionals;

  if (command === "pin") {
    if (!agent || !PIN_TARGETS.includes(target as (typeof PIN_TARGETS)[number])) {
      process.stdout.write("usage: pin <agent> <claude|opencode|auto>\n");
      return 2;
    }
    pin(paths, agent, target as (typeof PIN_TARGETS)[number]);
    process.stdout.write(`${agent}: pinned to ${target}.\n`);
  }
  if (command === "pin" || command === "sync") {
    process.stdout.write(`${describeSync(sync(paths, policyOf(options), checkModel)) || "Nothing to change."}\n`);
  }
  if (command === "list" || command === undefined || command === "pin" || command === "sync") {
    process.stdout.write(`\n${listAgents(paths, policyOf(options), options.cheapModel).join("\n")}\n`);
    return 0;
  }
  process.stdout.write(`unknown command: ${command}\n`);
  return 2;
}
