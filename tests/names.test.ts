import assert from "node:assert/strict";
import { test } from "node:test";
import { boomerangName, freeName } from "../scripts/lib/names.ts";

const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

test("the first free name", () => {
  assert.equal(freeName("boomerang-codex", ["boomerang-claude"]), "boomerang-codex");
  assert.equal(freeName("boomerang-codex", ["boomerang-codex"]), "boomerang-codex-2");
  assert.equal(freeName("boomerang-codex", ["boomerang-codex", "boomerang-codex-2"]), "boomerang-codex-3");
});

test("names follow Herdr's rule", () => {
  assert.equal(boomerangName("codex"), "boomerang-codex");
  assert.equal(boomerangName("codebase-scout"), "boomerang-codebase-scout");
  assert.equal(boomerangName("Log Digger!"), "boomerang-log-digger-");

  const long = boomerangName("architecture-advisor-with-a-very-long-name");
  assert.ok(long.length <= 32 - "-99".length, `too long: ${long}`);
  assert.match(long, HERDR_NAME);
  assert.match(freeName(long, [long]), HERDR_NAME);
});
