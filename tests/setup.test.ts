import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSetup } from "../scripts/entries/setup.ts";
import { loadSettings } from "../scripts/lib/settings.ts";

const PLUGIN_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RUN_MJS = join(PLUGIN_ROOT, "scripts", "run.mjs");

function temp(): { dataDir: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  return { dataDir: join(dir, "data"), settingsPath: join(dir, "settings.json") };
}

test("setup installs the launcher, points the status line at it, and keeps the old one", () => {
  const { dataDir, settingsPath } = temp();
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "~/old.sh" }, model: "opus" }));
  const message = runSetup(PLUGIN_ROOT, dataDir, settingsPath);

  const launcher = join(dataDir, "bin", "boomerang");
  assert.ok(existsSync(launcher));
  assert.equal(loadSettings(settingsPath).statusLine.command, `'${launcher}' statusline`);
  assert.equal(loadSettings(settingsPath).model, "opus");
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "chain.json"), "utf8")), { command: "~/old.sh" });
  assert.ok(message.includes("~/old.sh"));
});

test("setup a second time changes nothing and keeps the chained command", () => {
  const { dataDir, settingsPath } = temp();
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "~/old.sh" } }));
  runSetup(PLUGIN_ROOT, dataDir, settingsPath);
  const settingsBefore = readFileSync(settingsPath, "utf8");
  const message = runSetup(PLUGIN_ROOT, dataDir, settingsPath);
  assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "chain.json"), "utf8")), { command: "~/old.sh" });
  assert.ok(message.includes("already"));
});

test("setup with no previous status line says it installed one, not that nothing changed", () => {
  const { dataDir, settingsPath } = temp();
  const message = runSetup(PLUGIN_ROOT, dataDir, settingsPath);
  assert.ok(message.includes("now runs"));
  assert.equal(message.includes("Nothing changed"), false);
  assert.equal(message.includes("undefined"), false);
  assert.equal(existsSync(join(dataDir, "chain.json")), false);
});

test("the installed status line works end to end", () => {
  const { dataDir, settingsPath } = temp();
  runSetup(PLUGIN_ROOT, dataDir, settingsPath);
  const payload = { session_id: "s9", rate_limits: { five_hour: { used_percentage: 51, resets_at: 2_000_000_000 } } };
  const out = spawnSync("sh", ["-c", loadSettings(settingsPath).statusLine.command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(out.stdout, "5h 51%\n");
  assert.ok(existsSync(join(dataDir, "usage", "s9.json")));
});

test("SessionStart refreshes the launcher and reminds about setup until it is done", () => {
  const { dataDir } = temp();
  const home = mkdtempSync(join(tmpdir(), "boomerang-home-"));
  const sessionStart = () =>
    spawnSync(process.execPath, ["--no-warnings", RUN_MJS, "session-start"], {
      input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }),
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: "utf8",
    });

  const before = sessionStart();
  assert.equal(before.status, 0, before.stderr);
  assert.ok(JSON.parse(before.stdout).systemMessage.includes("/boomerang:setup"));
  assert.equal(readFileSync(join(dataDir, "plugin_root"), "utf8"), PLUGIN_ROOT);

  runSetup(PLUGIN_ROOT, dataDir, join(home, ".claude", "settings.json"));
  const after = sessionStart();
  assert.equal(after.stdout, "");
});

test("SessionStart applies the cheap-model rule to the agent files, and says a model problem only once", () => {
  const { dataDir } = temp();
  const home = mkdtempSync(join(tmpdir(), "boomerang-home-"));
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  const fleet = new URL("./fixtures/agents/", import.meta.url).pathname;
  for (const name of ["codebase-scout", "test-runner"]) {
    copyFileSync(join(fleet, `${name}.md`), join(home, ".claude", "agents", `${name}.md`));
  }
  runSetup(PLUGIN_ROOT, dataDir, join(home, ".claude", "settings.json")); // status line connected
  const bin = mkdtempSync(join(tmpdir(), "boomerang-bin-"));
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho openrouter/deepseek/deepseek-v4.1-flash\n", { mode: 0o755 });
  const sessionStart = (path: string) =>
    spawnSync(process.execPath, ["--no-warnings", RUN_MJS, "session-start"], {
      input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }),
      env: { PATH: path, HOME: home, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: "utf8",
    });

  const first = sessionStart(`${bin}:${process.env.PATH}`);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).systemMessage.includes("codebase-scout: now runs on the cheap model"));
  assert.ok(
    readFileSync(join(home, ".claude", "agents", "codebase-scout.md"), "utf8").includes("boomerang-proxy: true"),
  );
  assert.ok(existsSync(join(home, ".config", "opencode", "agents", "codebase-scout.md")));
  assert.equal(sessionStart(`${bin}:${process.env.PATH}`).stdout, "", "nothing new to say");

  // The model disappears (no opencode on PATH): agents go back to Claude, and the problem is said once.
  rmSync(join(dataDir, "opencode-models.json"));
  const noOpenCode = sessionStart("/usr/bin:/bin");
  assert.ok(JSON.parse(noOpenCode.stdout).systemMessage.includes("OpenCode is not installed"));
  rmSync(join(dataDir, "opencode-models.json"), { force: true });
  const again = sessionStart("/usr/bin:/bin");
  assert.equal(again.stdout, "", "the same problem is not repeated");
  assert.equal(
    readFileSync(join(home, ".claude", "agents", "codebase-scout.md"), "utf8").includes("boomerang-proxy"),
    false,
  );
});
