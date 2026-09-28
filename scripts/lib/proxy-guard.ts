// The check behind the proxy agents' PreToolUse hook. A proxy may run exactly one command shape:
//   '<launcher>' delegate <name> <<'BOOMERANG_TASK_<token>'
//   <task text, any lines>
//   BOOMERANG_TASK_<token>
// Everything else is denied. Found in the end-to-end run: Haiku, told "do not do the task
// yourself", still answered with find and grep. The hook makes that impossible, and it also
// approves the one allowed command, so the user gets no permission prompt for it.
import { shellQuote } from "./shell.ts";

export interface ProxyExpectation {
  launcher: string;
  name: string;
  token: string;
}

export type ProxyCheck = { allowed: true } | { allowed: false; reason: string };

export function checkProxyCommand(command: string, expected: ProxyExpectation): ProxyCheck {
  const endLine = `BOOMERANG_TASK_${expected.token}`;
  const firstLine = `${shellQuote(expected.launcher)} delegate ${expected.name} <<'${endLine}'`;
  const deny = (why: string): ProxyCheck => ({
    allowed: false,
    reason: `You may only run the delegate command from your instructions (${expected.launcher} delegate ${expected.name} with the task in the heredoc). ${why}`,
  });

  const lines = command.replace(/\n+$/, "").split("\n");
  if (lines[0] !== firstLine) return deny("This command is something else.");
  if (lines.length < 2 || lines[lines.length - 1] !== endLine) return deny("The heredoc must end with its end line.");
  if (lines.slice(1, -1).includes(endLine)) return deny("The task text must not contain the end line.");
  return { allowed: true };
}
