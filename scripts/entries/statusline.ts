// Entry: `boomerang statusline` (the statusLine command in settings.json, through the launcher).
import { text } from "node:stream/consumers";
import { statusLine } from "../lib/statusline.ts";

export async function main(): Promise<number> {
  const dataDir = process.env.BOOMERANG_DATA_DIR;
  let raw = "";
  try {
    raw = await text(process.stdin);
  } catch {
    // No input: print the default (empty) line below.
  }
  process.stdout.write(dataDir ? statusLine(raw, dataDir) : "\n");
  return 0;
}
