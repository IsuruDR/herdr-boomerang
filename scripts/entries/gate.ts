// Entry: `run.mjs gate --id <gate id> --handoff <path>`. Runs in the boomerang-codex pane in
// confirm mode. It shows the handoff, asks, prints one result line, and exits, so the pane is
// back at a shell prompt for `herdr agent start`. The runner waits for the result line.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { GateResult, gateLine } from "../lib/handback.ts";
import { PLUGIN_ID, SETTINGS_PATH, setPluginOption } from "../lib/settings.ts";

const PREVIEW_LINES = 40;

export interface GateDeps {
  readLine: (question: string) => Promise<string>;
  write: (text: string) => void;
  settingsPath: string;
}

function preview(handoffPath: string): string {
  try {
    return readFileSync(handoffPath, "utf8").split("\n").slice(0, PREVIEW_LINES).join("\n");
  } catch {
    return "(the handoff file could not be read)";
  }
}

/** Always returns 0: the result is the printed line, not the exit code. */
export async function runGate(args: string[], deps: GateDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { id: { type: "string" }, handoff: { type: "string" } } });
  const gateId = values.id ?? "";
  const handoffPath = values.handoff ?? "";

  deps.write("boomerang: Claude is near its usage limit and wrote this handoff for Codex.\n\n");
  deps.write(`${preview(handoffPath)}\n\n(full handoff: ${handoffPath})\n\n`);
  const answer = (await deps.readLine("[Enter] start Codex   [a] start and always auto-start   [q] cancel: "))
    .trim()
    .toLowerCase();

  if (answer === "q") {
    deps.write(`Cancelled. The handoff stays at ${handoffPath}.\n`);
    deps.write(`${gateLine(gateId, GateResult.Cancel)}\n`);
    return 0;
  }
  // "Always auto-start" changes a setting that lasts, so it needs a second, explicit yes.
  // A stray key (we once saw an unexplained "a" arrive) must never change it on its own.
  const alwaysAuto =
    answer === "a" &&
    ["y", "yes"].includes(
      (await deps.readLine("Save always auto-start in your settings? [y/N]: ")).trim().toLowerCase(),
    );
  if (answer === "a" && !alwaysAuto) deps.write("Starting Codex this time only.\n");
  if (alwaysAuto) {
    try {
      setPluginOption(deps.settingsPath, PLUGIN_ID, "switch_mode", "auto");
      deps.write("From now on Codex starts at once. Change it back in /config (boomerang: Switch mode).\n");
    } catch (error) {
      // The result line below must still print, or the runner waits for it for 24 hours.
      deps.write(
        `Could not save auto-start (${error instanceof Error ? error.message : error}). Starting Codex anyway.\n`,
      );
    }
  }
  deps.write(`${gateLine(gateId, GateResult.Start)}\n`);
  return 0;
}

export async function main(args: string[]): Promise<number> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runGate(args, {
      readLine: (question) => terminal.question(question),
      write: (text) => process.stdout.write(text),
      settingsPath: SETTINGS_PATH,
    });
  } finally {
    terminal.close();
  }
}
