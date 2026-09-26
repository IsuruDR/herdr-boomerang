import assert from "node:assert/strict";
import { test } from "node:test";
import { isOlderThan } from "../scripts/version.mjs";

const MINIMUM = [22, 18, 0];

test("a version below the minimum is older", () => {
  assert.equal(isOlderThan([22, 17, 9], MINIMUM), true);
  assert.equal(isOlderThan([20, 99, 0], MINIMUM), true);
});

test("the minimum itself and newer versions are not older", () => {
  assert.equal(isOlderThan([22, 18, 0], MINIMUM), false);
  assert.equal(isOlderThan([22, 18, 1], MINIMUM), false);
  assert.equal(isOlderThan([23, 0, 0], MINIMUM), false);
  assert.equal(isOlderThan([25, 4, 0], MINIMUM), false);
});
