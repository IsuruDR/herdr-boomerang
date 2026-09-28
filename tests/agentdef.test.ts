import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheapModelAgents,
  isProxy,
  parseAgent,
  parseAgentText,
  Runtime,
  runtimeFor,
  toOpenCode,
  toProxy,
} from "../scripts/lib/agentdef.ts";

const FLEET = new URL("./fixtures/agents/", import.meta.url).pathname;
const TEMPLATE_ROOT = new URL("..", import.meta.url).pathname;
const fleet = () =>
  readdirSync(FLEET)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseAgent(join(FLEET, f)));
const agent = (name: string) => parseAgent(join(FLEET, `${name}.md`));

const DEFAULT_POLICY = { agents: CheapModelAgents.LowEffort, canEditFiles: false };
const WIDE_POLICY = { agents: CheapModelAgents.LowAndMediumEffort, canEditFiles: true };

test("parse reads the frontmatter and the body", () => {
  const scout = agent("codebase-scout");
  assert.equal(scout.name, "codebase-scout");
  assert.equal(scout.frontmatter.model, "haiku");
  assert.deepEqual(scout.list("tools"), ["Read", "Grep", "Glob", "Bash"]);
  assert.deepEqual(scout.list("disallowedTools"), ["Write", "Edit", "NotebookEdit"]);
  assert.ok(scout.body.trim().length > 50);
});

test("a tools list with commas inside Agent(...) is split only at the top level", () => {
  const tools = agent("plan-executor").list("tools");
  assert.ok(tools.includes("TodoWrite"));
  const agentTool = tools.find((t) => t.startsWith("Agent("));
  assert.ok(agentTool?.includes("implementer, spec-reviewer"), agentTool);
});

test("a skills block list is read", () => {
  assert.deepEqual(agent("implementer").list("skills"), ["superpowers:test-driven-development"]);
});

test("the default rule sends only codebase-scout and log-digger to the cheap model", () => {
  const choices = Object.fromEntries(fleet().map((a) => [a.name, runtimeFor(a, DEFAULT_POLICY)]));
  const opencode = Object.keys(choices).filter((n) => choices[n].runtime === Runtime.OpenCode);
  assert.deepEqual(opencode.sort(), ["codebase-scout", "log-digger"]);
  assert.equal(choices["docs-researcher"].reason, "needs MCP tools that OpenCode does not have");
  assert.equal(choices["ticket-scribe"].reason, "needs MCP tools that OpenCode does not have");
  assert.equal(choices["build-fixer"].reason, "edits files");
  assert.equal(choices["test-runner"].reason, "medium effort");
  assert.equal(choices["brainstorm-partner"].reason, "needs MCP tools that OpenCode does not have");
  assert.equal(choices["codebase-scout"].reason, "low effort, read-only");
});

test("the widened rule adds medium-effort agents without MCP tools or Claude Code skills", () => {
  const choices = Object.fromEntries(fleet().map((a) => [a.name, runtimeFor(a, WIDE_POLICY)]));
  for (const name of [
    "codebase-scout",
    "log-digger",
    "build-fixer",
    "test-runner",
    "spec-reviewer",
    "quality-reviewer",
  ]) {
    assert.equal(choices[name].runtime, Runtime.OpenCode, name);
  }
  assert.equal(choices.implementer.runtime, Runtime.Claude, "implementer has context7 MCP tools");
  assert.equal(choices["data-investigator"].runtime, Runtime.Claude);
  assert.equal(choices["branch-prep"].reason, "preloads Claude Code skills");
  assert.equal(choices["plan-executor"].runtime, Runtime.Claude, "high effort");
});

test("a pin overrides the rule, but cannot send an agent where it cannot work", () => {
  const pinned = (name: string, runtime: string) => {
    const a = agent(name);
    return parseAgentText(a.path, a.withFrontmatter({ "boomerang-runtime": runtime }).text);
  };
  assert.deepEqual(runtimeFor(pinned("codebase-scout", "claude"), DEFAULT_POLICY), {
    runtime: Runtime.Claude,
    reason: "pinned to claude",
  });
  assert.deepEqual(runtimeFor(pinned("test-runner", "opencode"), DEFAULT_POLICY), {
    runtime: Runtime.OpenCode,
    reason: "pinned to opencode",
  });
  assert.equal(runtimeFor(pinned("docs-researcher", "opencode"), DEFAULT_POLICY).runtime, Runtime.Claude);
});

test("the OpenCode version maps permissions, keeps the body, and is marked as ours", () => {
  const scout = agent("codebase-scout");
  const text = toOpenCode(scout);
  const back = parseAgentText("x.md", text);
  assert.equal(back.frontmatter.description, scout.frontmatter.description);
  assert.equal(back.frontmatter.mode, "all");
  assert.ok(text.includes("permission:\n  edit: deny"));
  assert.ok(back.body.startsWith("<!-- managed by boomerang -->"));
  assert.ok(back.body.includes(scout.body.trim().slice(0, 60)));
  assert.equal(toOpenCode(agent("build-fixer")).includes("edit: deny"), false, "an agent that edits keeps edit rights");
});

test("the proxy keeps name and description, runs on Haiku with Bash only, and calls the launcher", () => {
  const scout = agent("codebase-scout");
  const proxy = parseAgentText("p.md", toProxy(scout, "/data/bin/boomerang", TEMPLATE_ROOT, "a1b2c3d4e5f6"));
  assert.equal(proxy.name, "codebase-scout");
  assert.equal(proxy.frontmatter.description, scout.frontmatter.description);
  assert.equal(proxy.frontmatter.model, "haiku");
  assert.deepEqual(proxy.list("tools"), ["Bash"]);
  assert.equal(proxy.frontmatter.maxTurns, "3");
  assert.equal(proxy.frontmatter.omitClaudeMd, "true");
  assert.ok(proxy.body.includes("'/data/bin/boomerang' delegate codebase-scout"));
  assert.equal(isProxy(proxy), true);
  assert.equal(isProxy(scout), false);
});

test("a file without valid frontmatter is rejected, not half-parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  writeFileSync(join(dir, "broken.md"), "no frontmatter here\n");
  assert.throws(() => parseAgent(join(dir, "broken.md")), /frontmatter/);
  writeFileSync(join(dir, "noname.md"), "---\ndescription: x\n---\nbody\n");
  assert.throws(() => parseAgent(join(dir, "noname.md")), /name/);
});

const agentFrom = (frontmatter: string, body = "Body text.\n") =>
  parseAgentText("t.md", `---\n${frontmatter}\n---\n${body}`);

test("none is a master switch: it beats a pin to opencode", () => {
  const pinned = agentFrom("name: scout\ndescription: x\ntools: Read, Grep\neffort: low\nboomerang-runtime: opencode");
  assert.deepEqual(runtimeFor(pinned, { agents: CheapModelAgents.None, canEditFiles: false }), {
    runtime: Runtime.Claude,
    reason: "cheap model is off",
  });
});

test("an agent with a tools allowlist and no write tools is read-only", () => {
  const readOnly = agentFrom("name: reader\ndescription: x\ntools: Read, Grep, Glob, Bash\neffort: low");
  assert.deepEqual(runtimeFor(readOnly, DEFAULT_POLICY), {
    runtime: Runtime.OpenCode,
    reason: "low effort, read-only",
  });
  assert.ok(toOpenCode(readOnly).includes("edit: deny"), "the twin must not get more rights than the Claude agent");
  const writer = agentFrom("name: writer\ndescription: x\ntools: Read, Edit\neffort: low");
  assert.equal(runtimeFor(writer, DEFAULT_POLICY).reason, "edits files");
});

test("an agent without a tools key, or with mcpServers, stays on Claude", () => {
  const inherits = agentFrom("name: all\ndescription: x\neffort: low");
  assert.equal(runtimeFor(inherits, DEFAULT_POLICY).reason, "inherits all tools, including MCP tools");
  const withServers = agentFrom("name: srv\ndescription: x\ntools: Read\neffort: low\nmcpServers:\n  - github");
  assert.equal(runtimeFor(withServers, DEFAULT_POLICY).reason, "needs MCP tools that OpenCode does not have");
});

test("a multi-line description is not supported, so the agent stays on Claude", () => {
  const folded = agentFrom("name: fold\ndescription: >-\n  Finds things\n  in code.\ntools: Read\neffort: low");
  assert.deepEqual(runtimeFor(folded, DEFAULT_POLICY), {
    runtime: Runtime.Claude,
    reason: "description format not supported (use one line)",
  });
});

test("names of OpenCode's built-in agents stay on Claude, so the twin never replaces them", () => {
  for (const name of ["plan", "build", "general", "explore"]) {
    const clash = agentFrom(`name: ${name}\ndescription: x\ntools: Read\neffort: low`);
    assert.equal(runtimeFor(clash, DEFAULT_POLICY).reason, "name is taken by an OpenCode built-in agent", name);
  }
});

test("the proxy's heredoc passes any task through bash unchanged, even one holding the plain delimiter", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  const launcher = join(dir, "fake-launcher");
  writeFileSync(launcher, `#!/bin/sh\ncat > '${dir}/got.txt'\n`, { mode: 0o755 });
  const proxy = parseAgentText("p.md", toProxy(agent("codebase-scout"), launcher, TEMPLATE_ROOT, "a1b2c3d4e5f6"));
  const block = proxy.body
    .split("\n")
    .filter((line) => line.startsWith("    "))
    .map((line) => line.slice(4))
    .join("\n");
  // SAFETY: the canary is a harmless `touch` inside this temp dir, never a destructive command.
  // If the heredoc ever broke, the worst case is one empty file here, and the test fails on it.
  const canary = join(dir, "INJECTED");
  const task = ["Find O'Reilly's $(whoami) and `date`", "BOOMERANG_TASK", `touch '${canary}'`, "last line"].join("\n");
  execFileSync("bash", ["-c", block.replace("<the full task you received>", task)], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
  });
  assert.equal(existsSync(canary), false, "a task line ran as a shell command");
  assert.equal(readFileSync(join(dir, "got.txt"), "utf8"), `${task}\n`);
  assert.ok(block.includes("BOOMERANG_TASK_a1b2c3d4e5f6"), "the delimiter carries the token");
});
