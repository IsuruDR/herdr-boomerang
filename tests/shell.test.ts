import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { shellQuote, splitArgs } from "../scripts/lib/shell.ts";

test("shellQuote keeps any value as one word, checked by a real shell", () => {
  for (const value of ["plain", "with space", "it's", `quote " and $HOME and \`cmd\``, "/path/with spaces/x.md"]) {
    const echoed = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
    assert.equal(echoed, value);
  }
});

test("splitArgs splits like a shell without running one", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs("  --no-daemon  "), ["--no-daemon"]);
  assert.deepEqual(splitArgs('--sandbox "workspace write" -c x=1'), ["--sandbox", "workspace write", "-c", "x=1"]);
  assert.deepEqual(splitArgs("--msg 'it''s' a\\ b"), ["--msg", "its", "a b"]);
  assert.deepEqual(splitArgs('""'), [""]);
});

test("splitArgs rejects an unclosed quote instead of guessing", () => {
  assert.throws(() => splitArgs('--sandbox "workspace'), /unclosed/);
});
