// Entry: `run.mjs runner ...`. Started detached by dispatch.ts, one per handoff.
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { herdrRunner } from "../lib/herdr.ts";
import { logError } from "../lib/log.ts";
import { runHandoff } from "../lib/runner.ts";

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      session: { type: "string" },
      "codex-pane": { type: "string" },
      "codex-name": { type: "string" },
      "claude-name": { type: "string" },
      handoff: { type: "string" },
      cwd: { type: "string" },
      mode: { type: "string" },
      "gate-id": { type: "string" },
      "reset-after": { type: "string" },
      "hand-back": { type: "string" },
      "codex-args": { type: "string" },
    },
  });
  const dataDir = values["data-dir"];
  try {
    await runHandoff(
      {
        dataDir: dataDir ?? "",
        codexPane: values["codex-pane"] ?? "",
        codexName: values["codex-name"] ?? "",
        claudeName: values["claude-name"] ?? "",
        handoffPath: values.handoff ?? "",
        cwd: values.cwd ?? "",
        mode: values.mode ?? "confirm",
        gateId: values["gate-id"] ?? "",
        resetAfter: Number(values["reset-after"] ?? 0),
        handBack: values["hand-back"] === "1",
        codexArgs: values["codex-args"] ?? "",
      },
      {
        run: herdrRunner,
        now: () => Math.floor(Date.now() / 1000),
        sleep: (seconds) => delay(seconds * 1000),
      },
    );
  } catch (error) {
    logError(dataDir, "runner", error);
  }
  return 0;
}
