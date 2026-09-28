// Entry: `boomerang proxy-guard <agent> <token>` (through the launcher), the PreToolUse hook that
// each proxy agent declares in its frontmatter. It reads the Bash command from stdin and answers
// allow for the proxy's own delegate command, deny for anything else.
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { readHookInput } from "../lib/hook-io.ts";
import { checkProxyCommand } from "../lib/proxy-guard.ts";

function decision(permissionDecision: "allow" | "deny", reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
  });
}

export async function main(args: string[]): Promise<number> {
  const [name, token] = args;
  const dataDir = process.env.BOOMERANG_DATA_DIR ?? "";
  const input = readHookInput(await text(process.stdin));
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const check = checkProxyCommand(command, {
    launcher: join(dataDir, "bin", "boomerang"),
    name: name ?? "",
    token: token ?? "",
  });
  process.stdout.write(
    check.allowed ? decision("allow", "boomerang proxy: its own delegate command") : decision("deny", check.reason),
  );
  return 0;
}
