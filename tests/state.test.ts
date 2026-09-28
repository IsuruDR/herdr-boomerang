import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadState, NORMAL_STATE, Phase, saveState, writeJsonAtomic } from "../scripts/lib/state.ts";

const NOW = 1_000_000;

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "boomerang-"));
}

test("a saved state loads back while its limit window is open", () => {
  const dir = dataDir();
  saveState(dir, "s1", { phase: Phase.HandedOff, resetAfter: NOW + 60 });
  assert.deepEqual(loadState(dir, "s1", NOW), { phase: Phase.HandedOff, resetAfter: NOW + 60 });
});

test("the state goes back to normal once the limit window has reset", () => {
  const dir = dataDir();
  saveState(dir, "s1", { phase: Phase.Warned, resetAfter: NOW + 60 });
  assert.deepEqual(loadState(dir, "s1", NOW + 60), NORMAL_STATE);
});

test("a missing or damaged state file means normal", () => {
  const dir = dataDir();
  assert.deepEqual(loadState(dir, "absent", NOW), NORMAL_STATE);
  writeJsonAtomic(join(dir, "state", "s1.json"), { phase: "exploded", resetAfter: NOW + 60 });
  assert.deepEqual(loadState(dir, "s1", NOW), NORMAL_STATE);
});

test("the atomic write leaves only the final file", () => {
  const dir = dataDir();
  const path = join(dir, "nested", "out.json");
  writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(readdirSync(join(dir, "nested")), ["out.json"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 });
});
