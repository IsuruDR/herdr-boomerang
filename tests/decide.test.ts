import assert from "node:assert/strict";
import { test } from "node:test";
import { Action, onStop, onStopFailure, onToolBatch } from "../scripts/lib/decide.ts";
import { Phase } from "../scripts/lib/state.ts";

test("tool batch warns once", () => {
  assert.deepEqual(onToolBatch(Phase.Normal, true), { action: Action.InjectInstruction, nextPhase: Phase.Warned });
  assert.deepEqual(onToolBatch(Phase.Warned, true), { action: Action.None, nextPhase: Phase.Warned });
});

test("tool batch under the threshold does nothing", () => {
  assert.deepEqual(onToolBatch(Phase.Normal, false), { action: Action.None, nextPhase: Phase.Normal });
});

test("stop under the threshold does nothing", () => {
  assert.deepEqual(onStop(Phase.Normal, false, false, false), { action: Action.None, nextPhase: Phase.Normal });
});

test("stop over the threshold blocks with the instruction", () => {
  assert.deepEqual(onStop(Phase.Normal, true, false, false), { action: Action.BlockStop, nextPhase: Phase.Warned });
});

test("stop with the handoff marker hands off Claude's summary", () => {
  assert.deepEqual(onStop(Phase.Warned, true, true, false), {
    action: Action.HandOffSummary,
    nextPhase: Phase.HandedOff,
  });
});

test("stop without the marker reminds once, then falls back to the transcript", () => {
  assert.deepEqual(onStop(Phase.Warned, true, false, false), { action: Action.BlockStop, nextPhase: Phase.Warned });
  assert.deepEqual(onStop(Phase.Warned, true, false, true), {
    action: Action.HandOffTranscript,
    nextPhase: Phase.HandedOff,
  });
});

test("a handed-off session is left alone", () => {
  const leftAlone = { action: Action.None, nextPhase: Phase.HandedOff };
  assert.deepEqual(onToolBatch(Phase.HandedOff, true), leftAlone);
  assert.deepEqual(onStop(Phase.HandedOff, true, true, true), leftAlone);
  assert.deepEqual(onStopFailure(Phase.HandedOff, "rate_limit"), leftAlone);
});

test("a rate-limit failure falls back to the transcript; other errors do nothing", () => {
  for (const phase of [Phase.Normal, Phase.Warned]) {
    assert.deepEqual(onStopFailure(phase, "rate_limit"), {
      action: Action.HandOffTranscript,
      nextPhase: Phase.HandedOff,
    });
    assert.deepEqual(onStopFailure(phase, "overloaded"), { action: Action.None, nextPhase: phase });
  }
});
