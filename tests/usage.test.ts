import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSnapshot, windowsOverThreshold } from "../scripts/lib/usage.ts";

const NOW = 1_000_000;
const thresholds = { five_hour: 85, seven_day: 95 };

function emptyDataDir(): string {
  return mkdtempSync(join(tmpdir(), "boomerang-"));
}

function dataDirWith(payload: string): string {
  const dir = emptyDataDir();
  mkdirSync(join(dir, "usage"));
  writeFileSync(join(dir, "usage", "s1.json"), payload);
  return dir;
}

test("reports each window at or over its threshold", () => {
  const dir = dataDirWith(
    JSON.stringify({
      five_hour: { used_percentage: 85, resets_at: NOW + 60 },
      seven_day: { used_percentage: 40, resets_at: NOW + 60 },
    }),
  );
  const over = windowsOverThreshold(readSnapshot(dir, "s1"), thresholds, NOW);
  assert.deepEqual(
    over.map((w) => w.name),
    ["five_hour"],
  );
});

test("ignores a window that already reset", () => {
  const dir = dataDirWith(JSON.stringify({ five_hour: { used_percentage: 99, resets_at: NOW - 1 } }));
  assert.deepEqual(windowsOverThreshold(readSnapshot(dir, "s1"), thresholds, NOW), []);
});

test("missing or broken file means no snapshot", () => {
  assert.equal(readSnapshot(emptyDataDir(), "absent"), undefined);
  assert.equal(readSnapshot(dataDirWith("{not json"), "s1"), undefined);
});

test("a window with missing or wrong fields is left out", () => {
  const dir = dataDirWith(
    JSON.stringify({
      five_hour: { used_percentage: "90", resets_at: NOW + 60 },
      seven_day: { used_percentage: 97, resets_at: NOW + 60 },
    }),
  );
  assert.deepEqual(
    readSnapshot(dir, "s1")?.map((w) => w.name),
    ["seven_day"],
  );
});
