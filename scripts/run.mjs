// boomerang entry guard. Every hook, the launcher and the pane commands start here:
//   node --no-warnings run.mjs <entry> [args...]
// Plain JavaScript on purpose: an old Node cannot parse the .ts entries at all,
// so we check the version before we import one.
import { isOlderThan } from "./version.mjs";

const MINIMUM_NODE = [22, 18, 0];
const [entry, ...args] = process.argv.slice(2);
const currentNode = process.versions.node.split(".").map(Number);

// Hooks and the status line must stay quiet (their output goes to Claude Code); the other
// entries run in a terminal or for a person, so they say why they stop.
const QUIET_ENTRIES = new Set(["tool-batch", "stop", "stop-failure", "statusline", "proxy-guard"]);

if (isOlderThan(currentNode, MINIMUM_NODE)) {
  const message = `boomerang needs Node 22.18 or later (found ${process.versions.node}).`;
  if (entry === "session-start") process.stdout.write(JSON.stringify({ systemMessage: message }));
  else if (!QUIET_ENTRIES.has(entry)) process.stderr.write(`${message}\n`);
  process.exit(0);
}

const { main } = await import(new URL(`./entries/${entry}.ts`, import.meta.url).href);
process.exitCode = await main(args);
