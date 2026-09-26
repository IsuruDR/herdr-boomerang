import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installStatusLine, loadSettings, PLUGIN_ID, pluginOptions, setPluginOption } from "../scripts/lib/settings.ts";

function settingsFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "boomerang-")), "settings.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

test("setPluginOption keeps all other settings", () => {
  const path = settingsFile({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
    pluginConfigs: { "other@market": { options: { a: 1 } } },
  });
  setPluginOption(path, PLUGIN_ID, "switch_mode", "auto");
  const saved = loadSettings(path);
  assert.deepEqual(saved.hooks, { Stop: [{ hooks: [{ type: "command", command: "x" }] }] });
  assert.deepEqual(saved.pluginConfigs["other@market"], { options: { a: 1 } });
  assert.equal(saved.pluginConfigs[PLUGIN_ID].options.switch_mode, "auto");
  assert.deepEqual(pluginOptions(path, PLUGIN_ID), { switch_mode: "auto" });
});

test("a missing settings file is treated as empty and gets created", () => {
  const path = join(mkdtempSync(join(tmpdir(), "boomerang-")), "settings.json");
  assert.deepEqual(loadSettings(path), {});
  assert.deepEqual(pluginOptions(path, PLUGIN_ID), {});
  setPluginOption(path, PLUGIN_ID, "hand_back", false);
  assert.equal(loadSettings(path).pluginConfigs[PLUGIN_ID].options.hand_back, false);
});

test("installStatusLine reports what it replaced, keeps other statusLine keys, and is idempotent", () => {
  const path = settingsFile({ statusLine: { type: "command", command: "old.sh", padding: 2 }, model: "opus" });
  const ours = "'/data/bin/boomerang' statusline";
  assert.deepEqual(installStatusLine(path, ours), {
    kind: "installed",
    previous: { type: "command", command: "old.sh", padding: 2 },
  });
  assert.deepEqual(loadSettings(path).statusLine, { type: "command", command: ours, padding: 2 });
  assert.equal(loadSettings(path).model, "opus");

  const beforeText = readFileSync(path, "utf8");
  const before = statSync(path).mtimeMs;
  assert.deepEqual(installStatusLine(path, ours), { kind: "already_installed" });
  assert.equal(readFileSync(path, "utf8"), beforeText);
  assert.equal(statSync(path).mtimeMs, before);
});

test("installStatusLine with no previous status line says it installed one", () => {
  const path = settingsFile({});
  assert.deepEqual(installStatusLine(path, "'/data/bin/boomerang' statusline"), {
    kind: "installed",
    previous: undefined,
  });
  assert.equal(loadSettings(path).statusLine.command, "'/data/bin/boomerang' statusline");
});

test("writing settings keeps a symlinked settings.json a symlink, and keeps its mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const real = join(dir, "dotfiles-settings.json");
  writeFileSync(real, JSON.stringify({ model: "opus" }));
  chmodSync(real, 0o600);
  const link = join(dir, "settings.json");
  symlinkSync(real, link);

  setPluginOption(link, PLUGIN_ID, "switch_mode", "auto");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(loadSettings(real).pluginConfigs[PLUGIN_ID].options.switch_mode, "auto");
});
