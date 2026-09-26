// boomerang entry guard. Every hook, the launcher and the pane commands start here:
//   node --no-warnings run.mjs <entry> [args...]
// Plain JavaScript on purpose: an old Node cannot parse the .ts entries at all,
// so we check the version before we import one.
import { isOlderThan } from "./version.mjs";

const MINIMUM_NODE = [22, 18, 0];
const [entry, ...args] = process.argv.slice(2);
const currentNode = process.versions.node.split(".").map(Number);

if (isOlderThan(currentNode, MINIMUM_NODE)) {
  if (entry === "session-start") {
    process.stdout.write(
      JSON.stringify({ systemMessage: `boomerang needs Node 22.18 or later (found ${process.versions.node}).` }),
    );
  }
  process.exit(0);
}

const { main } = await import(new URL(`./entries/${entry}.ts`, import.meta.url).href);
process.exitCode = await main(args);
