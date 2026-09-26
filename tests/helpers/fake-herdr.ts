// A fake Herdr runner for tests. It records every call and answers from the recorded
// fixtures in tests/fixtures/herdr, so the adapter is tested against real output shapes.
import { readFileSync } from "node:fs";
import { HerdrError, type Runner, type RunOptions } from "../../scripts/lib/herdr.ts";

const FIXTURES = new URL("../fixtures/herdr/", import.meta.url);

export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export interface Call {
  args: string[];
  opts?: RunOptions;
}

type Answer = { stdout: string } | { errorJson: string };

/** Answers match on the start of the argument list, for example ["agent", "get"]. First match wins. */
export function fakeHerdr(answers: Array<[string[], Answer]>): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (args, opts) => {
    calls.push({ args, opts });
    const match = answers.find(([prefix]) => prefix.every((part, i) => args[i] === part));
    if (!match) throw new Error(`fake herdr: no answer for ${args.join(" ")}`);
    const answer = match[1];
    if ("stdout" in answer) return answer.stdout;
    throw HerdrError.fromStderr(args, answer.errorJson);
  };
  return { run, calls };
}

export const ok = (fixtureName: string): Answer => ({ stdout: fixture(fixtureName) });
export const fails = (fixtureName: string): Answer => ({ errorJson: fixture(fixtureName) });
