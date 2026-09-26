import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codexPrompt,
  containsHandoff,
  extractHandoff,
  fallbackHandoff,
  gitStatus,
  HANDOFF_MARKER,
  handBackPrompt,
  instruction,
  recentUserPrompts,
  reportPath,
  saveHandoff,
} from "../scripts/lib/handoff.ts";

const FIXTURE = new URL("./fixtures/transcript.jsonl", import.meta.url).pathname;

test("extract returns the text after the marker", () => {
  const reply = `Stopping here.\n${HANDOFF_MARKER}\n## Goal\nX`;
  assert.equal(containsHandoff(reply), true);
  assert.equal(extractHandoff(reply), "## Goal\nX");
  assert.equal(containsHandoff("A normal reply"), false);
  assert.equal(containsHandoff(undefined), false);
});

test("recent user prompts keep only what the user typed", () => {
  assert.deepEqual(recentUserPrompts(FIXTURE), ["Add rate limiting to the pipeline API", "Also cover the 429 path"]);
  assert.deepEqual(recentUserPrompts(FIXTURE, 1), ["Also cover the 429 path"]);
  assert.deepEqual(recentUserPrompts("/nonexistent/transcript.jsonl"), []);
});

test("the fallback names the transcript, the prompts and the git state", () => {
  const text = fallbackHandoff("/t/session.jsonl", ["first ask", "second ask"], " M src/api.ts");
  for (const part of ["/t/session.jsonl", "first ask", "second ask", " M src/api.ts", "git diff"]) {
    assert.ok(text.includes(part), `missing: ${part}`);
  }
});

test("the instruction names the window, the percentage and the marker", () => {
  const text = instruction([{ name: "five_hour", usedPercentage: 87.4, resetsAt: 0 }]);
  assert.ok(text.includes("5-hour usage is at 87%"));
  assert.ok(text.includes(HANDOFF_MARKER));
});

test("the handoff is saved per session, and the report path sits next to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const path = saveHandoff(dir, "s1", "## Goal\nX");
  assert.equal(path, join(dir, "handoffs", "s1.md"));
  assert.equal(readFileSync(path, "utf8"), "## Goal\nX\n");
  assert.equal(reportPath(path), join(dir, "handoffs", "s1.report.md"));
});

test("the Codex prompt points at the handoff and asks for the report", () => {
  const text = codexPrompt("/d/handoffs/s1.md", "/repo");
  assert.ok(text.includes("/d/handoffs/s1.md"));
  assert.ok(text.includes("/d/handoffs/s1.report.md"));
  assert.ok(text.includes("/repo"));
});

test("the hand-back prompt without a report points to git diff", () => {
  assert.ok(handBackPrompt("/d/r.md", true).includes("/d/r.md"));
  const noReport = handBackPrompt("/d/r.md", false);
  assert.ok(noReport.includes("without writing a report"));
  assert.ok(noReport.includes("git diff"));
});

test("git status outside a repository says so", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "boomerang-"));
  assert.equal(existsSync(join(notARepo, ".git")), false);
  assert.equal(gitStatus(notARepo), "(not a git repository)");
});

test("recent prompts come from the end of a large transcript without reading it all", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const path = join(dir, "big.jsonl");
  const filler = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } })}\n`;
  const early = `${JSON.stringify({ type: "user", message: { content: "an early prompt far back" } })}\n`;
  const late = `${JSON.stringify({ type: "user", message: { content: "the latest prompt" } })}\n`;
  writeFileSync(path, early + filler.repeat(3000) + late); // about 3 MB
  assert.deepEqual(recentUserPrompts(path), ["the latest prompt"]);
});

test("only Claude Code's own wrappers are skipped; a pasted HTML question still counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const path = join(dir, "t.jsonl");
  const entry = (content: string) => `${JSON.stringify({ type: "user", message: { content } })}\n`;
  writeFileSync(
    path,
    entry("<command-name>/clear</command-name>") +
      entry("<local-command-stdout>ok</local-command-stdout>") +
      entry("<system-reminder>x</system-reminder>") +
      entry("<div>why does this div not center?</div>"),
  );
  assert.deepEqual(recentUserPrompts(path), ["<div>why does this div not center?</div>"]);
});
