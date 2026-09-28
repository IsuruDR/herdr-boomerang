// Entry: `boomerang delegate <agent>` (the launcher), with the task on stdin. Proxy subagents
// call this. It prints the agent's answer and exits 0, or prints why it could not and exits
// 1 (failed) or 2 (not available). The launcher is not a hook, so options come from settings.json.
import { text } from "node:stream/consumers";
import { DelegateOutcome, delegate, opencodeHeadless } from "../lib/delegate.ts";
import { herdrRunner } from "../lib/herdr.ts";
import { optionsFromSettings } from "../lib/hook-io.ts";
import { logError } from "../lib/log.ts";
import { modelAvailability } from "../lib/models.ts";
import { PLUGIN_ID, pluginOptions, SETTINGS_PATH } from "../lib/settings.ts";

export async function main(args: string[]): Promise<number> {
  const [agent] = args;
  const dataDir = process.env.BOOMERANG_DATA_DIR;
  if (!agent || !dataDir) {
    process.stdout.write("boomerang delegate: usage is `boomerang delegate <agent>` with the task on stdin\n");
    return 2;
  }
  try {
    const task = (await text(process.stdin)).trim();
    if (!task) {
      process.stdout.write(`boomerang: ${agent} got an empty task; nothing was started\n`);
      return 2;
    }
    const options = optionsFromSettings(pluginOptions(SETTINGS_PATH, PLUGIN_ID));
    const result = delegate({
      agent,
      task,
      cwd: process.cwd(),
      env: process.env,
      dataDir,
      options,
      run: herdrRunner,
      headless: opencodeHeadless,
      checkModel: () => modelAvailability(options.cheapModel, dataDir, Math.floor(Date.now() / 1000)),
    });
    if (result.kind === DelegateOutcome.Done) {
      process.stdout.write(result.report);
      return 0;
    }
    if (result.kind === DelegateOutcome.Unavailable) {
      process.stdout.write(`boomerang: ${agent} is not available on the cheap model: ${result.reason}\n`);
      return 2;
    }
    process.stdout.write(`boomerang: ${agent} failed: ${result.reason}\n${result.tail}\n`);
    return 1;
  } catch (error) {
    logError(dataDir, "delegate", error);
    process.stdout.write(`boomerang: ${agent} failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}
