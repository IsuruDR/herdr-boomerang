import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProxyCommand } from "../scripts/lib/proxy-guard.ts";

const expected = { launcher: "/data/bin/boomerang", name: "codebase-scout", token: "a1b2c3d4e5f6" };
const RUN_MJS = new URL("../scripts/run.mjs", import.meta.url).pathname;
const head = "'/data/bin/boomerang' delegate codebase-scout <<'BOOMERANG_TASK_a1b2c3d4e5f6'";
const end = "BOOMERANG_TASK_a1b2c3d4e5f6";
const command = (...body: string[]) => [head, ...body, end].join("\n");

test("the exact delegate command with any task text is allowed", () => {
  assert.deepEqual(
    checkProxyCommand(command("Where is freeName defined?", "Line two with $(x) and 'quotes'"), expected),
    {
      allowed: true,
    },
  );
  assert.deepEqual(
    checkProxyCommand(`${command("task")}\n`, expected),
    { allowed: true },
    "a trailing newline is fine",
  );
});

test("the proxy doing the task itself is denied", () => {
  const result = checkProxyCommand('grep -rn "function freeName" .', expected);
  assert.equal(result.allowed, false);
  assert.ok(!result.allowed && result.reason.includes("only run"));
});

test("anything that could run a second command is denied", () => {
  assert.equal(
    checkProxyCommand(`${command("task")}\ngrep -rn x .`, expected).allowed,
    false,
    "command after the end line",
  );
  assert.equal(
    checkProxyCommand(command("task", end, "grep -rn x ."), expected).allowed,
    false,
    "early end line in the body",
  );
  assert.equal(checkProxyCommand(`${head}; ls\n${end}`, expected).allowed, false, "extra command on the first line");
  assert.equal(checkProxyCommand(command("task").replace("codebase-scout", "log-digger"), expected).allowed, false);
  assert.equal(checkProxyCommand(command("task").replaceAll("a1b2c3d4e5f6", "000000000000"), expected).allowed, false);
});

test("the guard entry answers Claude Code's PreToolUse hook with allow or deny", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const hook = (cmd: string) =>
    spawnSync(process.execPath, ["--no-warnings", RUN_MJS, "proxy-guard", "codebase-scout", "a1b2c3d4e5f6"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd } }),
      env: { PATH: process.env.PATH, HOME: dataDir, BOOMERANG_DATA_DIR: dataDir },
      encoding: "utf8",
    });
  const launcherHead = `'${join(dataDir, "bin", "boomerang")}' delegate codebase-scout <<'BOOMERANG_TASK_a1b2c3d4e5f6'`;
  const allowed = JSON.parse(hook(`${launcherHead}\ntask\n${end}`).stdout);
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
  const denied = JSON.parse(hook("grep -rn freeName .").stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes("delegate codebase-scout"));
});
