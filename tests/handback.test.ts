import assert from "node:assert/strict";
import { test } from "node:test";
import { afterPrompt, afterStalledCheck, HandBack, handBackAction, Next } from "../scripts/lib/handback.ts";
import { AgentStatus, PromptOutcome } from "../scripts/lib/herdr.ts";

test("after the Codex prompt", () => {
  assert.equal(afterPrompt("done", false), Next.Finished);
  assert.equal(afterPrompt("idle", false), Next.Finished);
  assert.equal(afterPrompt("blocked", false), Next.WaitForUser);
  assert.equal(afterPrompt(PromptOutcome.Stalled, false), Next.CheckOnce);
});

test("Codex exiting right after start gets one retry without the background server", () => {
  assert.equal(afterPrompt(PromptOutcome.NotRunning, false), Next.RetryWithoutDaemon);
  assert.equal(afterPrompt(PromptOutcome.NotRunning, true), Next.GiveUp);
});

test("after a stall: a busy Codex got the prompt; an idle Codex lost it and gets one re-send", () => {
  assert.equal(afterStalledCheck("working", false), Next.WaitForUser);
  assert.equal(afterStalledCheck("blocked", false), Next.WaitForUser);
  assert.equal(afterStalledCheck("idle", false), Next.ResendOnce);
  assert.equal(afterStalledCheck("idle", true), Next.GiveUp);
  assert.equal(afterStalledCheck("done", true), Next.GiveUp);
  assert.equal(afterStalledCheck(AgentStatus.NotFound, false), Next.GiveUp);
});

test("hand back only to a Claude that is ready for input", () => {
  assert.equal(handBackAction(true, "idle"), HandBack.PromptClaude);
  assert.equal(handBackAction(true, "done"), HandBack.PromptClaude);
  for (const busyOrGone of ["working", "blocked", "unknown", AgentStatus.NotFound]) {
    assert.equal(handBackAction(true, busyOrGone), HandBack.NotifyOnly);
  }
  assert.equal(handBackAction(false, "idle"), HandBack.NotifyOnly);
});
