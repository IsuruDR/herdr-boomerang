import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGate } from "../scripts/entries/gate.ts";
import { GateResult, gateResult, gateResultRegex } from "../scripts/lib/handback.ts";
import { loadSettings, PLUGIN_ID } from "../scripts/lib/settings.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const handoff = join(dir, "s1.md");
  writeFileSync(handoff, `${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ model: "opus" }));
  const output: string[] = [];
  return { handoff, settingsPath, output, write: (text: string) => output.push(text) };
}

async function gateWith(...answers: string[]) {
  const s = setup();
  const code = await runGate(["--id", "ab12cd34", "--handoff", s.handoff], {
    readLine: async () => answers.shift() ?? "",
    write: s.write,
    settingsPath: s.settingsPath,
  });
  return { ...s, code, text: s.output.join("") };
}

test("Enter prints start and leaves the settings alone", async () => {
  const { code, text, settingsPath } = await gateWith("");
  assert.equal(code, 0);
  assert.ok(text.includes("line 40"));
  assert.equal(text.includes("line 41"), false);
  assert.equal(gateResult(text, "ab12cd34"), GateResult.Start);
  assert.deepEqual(loadSettings(settingsPath), { model: "opus" });
});

test("a, then y, saves auto mode and prints start", async () => {
  const { text, settingsPath } = await gateWith("a", "y");
  assert.equal(gateResult(text, "ab12cd34"), GateResult.Start);
  assert.equal(loadSettings(settingsPath).pluginConfigs[PLUGIN_ID].options.switch_mode, "auto");
  assert.equal(loadSettings(settingsPath).model, "opus");
});

test("q prints cancel and names the saved handoff", async () => {
  const { text, handoff } = await gateWith("q");
  assert.equal(gateResult(text, "ab12cd34"), GateResult.Cancel);
  assert.ok(text.includes(handoff));
});

test("the result regex matches only this gate's id", async () => {
  const { text } = await gateWith("");
  assert.match(text, new RegExp(gateResultRegex("ab12cd34")));
  assert.equal(new RegExp(gateResultRegex("ffffffff")).test(text), false);
});

test("no source file holds the full marker, so a screen echo can never match it", () => {
  for (const file of ["../scripts/entries/gate.ts", "../scripts/lib/handback.ts", "../scripts/lib/dispatch.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("BOOMERANG_GATE"), false, `${file} holds the literal marker`);
  }
});

test("a settings file that cannot be written still ends with the start line", async () => {
  const s = setup();
  writeFileSync(s.settingsPath, "{ not json");
  const code = await runGate(["--id", "ab12cd34", "--handoff", s.handoff], {
    readLine: (() => {
      const answers = ["a", "y"];
      return async () => answers.shift() ?? "";
    })(),
    write: s.write,
    settingsPath: s.settingsPath,
  });
  const text = s.output.join("");
  assert.equal(code, 0);
  assert.ok(text.includes("Could not save auto-start"));
  assert.equal(gateResult(text, "ab12cd34"), GateResult.Start);
});

test("a without a clear yes starts Codex once and saves nothing", async () => {
  for (const second of ["", "n", "a", "yes please"]) {
    const { text, settingsPath } = await gateWith("a", second);
    assert.equal(gateResult(text, "ab12cd34"), GateResult.Start);
    assert.deepEqual(loadSettings(settingsPath), { model: "opus" }, `second answer: ${JSON.stringify(second)}`);
  }
});
