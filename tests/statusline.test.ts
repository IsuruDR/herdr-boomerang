import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installLauncher } from "../scripts/lib/launcher.ts";
import { recordUsage, render } from "../scripts/lib/statusline.ts";
import { readSnapshot, usagePath } from "../scripts/lib/usage.ts";

const PLUGIN_ROOT = new URL("..", import.meta.url).pathname;

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "boomerang-"));
}

const payload = {
  session_id: "s1",
  context_window: { used_percentage: 23.4 },
  rate_limits: {
    five_hour: { used_percentage: 42.2, resets_at: 2_000_000_000 },
    seven_day: { used_percentage: 61, resets_at: 2_000_500_000 },
  },
};

test("recorded usage is readable by the hooks (the file format contract)", () => {
  const dir = dataDir();
  recordUsage(payload, dir);
  assert.deepEqual(readSnapshot(dir, "s1"), [
    { name: "five_hour", usedPercentage: 42.2, resetsAt: 2_000_000_000 },
    { name: "seven_day", usedPercentage: 61, resetsAt: 2_000_500_000 },
  ]);
});

test("no rate limits (API-key users) writes nothing", () => {
  const dir = dataDir();
  recordUsage({ session_id: "s1", context_window: { used_percentage: 10 } }, dir);
  assert.equal(existsSync(usagePath(dir, "s1")), false);
  recordUsage({ rate_limits: payload.rate_limits }, dir); // no session id either
  assert.equal(existsSync(join(dir, "usage")), false);
});

test("a chained status line gets the same input and its output passes through", () => {
  const dir = dataDir();
  writeFileSync(join(dir, "chain.json"), JSON.stringify({ command: "cat" }));
  const raw = JSON.stringify(payload);
  assert.equal(render(raw, dir), raw);
  writeFileSync(join(dir, "chain.json"), JSON.stringify({ command: "echo previous" }));
  assert.equal(render(raw, dir), "previous\n");
});

test("the default line shows what it has, and leaves out the rest", () => {
  const dir = dataDir();
  assert.equal(render(JSON.stringify(payload), dir), "5h 42% | 7d 61% | ctx 23%\n");
  assert.equal(render(JSON.stringify({ context_window: { used_percentage: 5 } }), dir), "ctx 5%\n");
  assert.equal(render("not json", dir), "\n");
});

test("a failing chained command falls back to the default line", () => {
  const dir = dataDir();
  writeFileSync(join(dir, "chain.json"), JSON.stringify({ command: "exit 3" }));
  assert.equal(render(JSON.stringify(payload), dir), "5h 42% | 7d 61% | ctx 23%\n");
});

test("installLauncher points at the current plugin root and is idempotent", () => {
  const dir = dataDir();
  const launcher = installLauncher("/plugins/boomerang/0.1.0", dir, PLUGIN_ROOT);
  assert.equal(launcher, join(dir, "bin", "boomerang"));
  assert.equal(readFileSync(join(dir, "plugin_root"), "utf8"), "/plugins/boomerang/0.1.0");
  const script = readFileSync(launcher, "utf8");
  assert.ok(script.includes(`DATA_DIR="${dir}"`));
  assert.equal(statSync(launcher).mode & 0o111, 0o111);

  const firstWrite = statSync(launcher).mtimeMs;
  installLauncher("/plugins/boomerang/0.2.0", dir, PLUGIN_ROOT);
  assert.equal(readFileSync(join(dir, "plugin_root"), "utf8"), "/plugins/boomerang/0.2.0");
  assert.equal(statSync(launcher).mtimeMs, firstWrite);
});

test("a session id with path characters is not written", () => {
  const dir = dataDir();
  recordUsage({ ...payload, session_id: "../escape" }, dir);
  assert.equal(existsSync(join(dir, "usage")), false);
});

test("a data dir with $& in its name is written into the launcher as-is", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "boomerang-")), "odd$&name");
  const launcher = installLauncher("/plugins/boomerang/0.1.0", dir, PLUGIN_ROOT);
  assert.ok(readFileSync(launcher, "utf8").includes(`DATA_DIR="${dir.replace("$", "\\$")}"`));
});
