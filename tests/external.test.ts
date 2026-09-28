import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheapModelAgents, parseAgent } from "../scripts/lib/agentdef.ts";
import { type ExternalPaths, listAgents, pin, sync } from "../scripts/lib/external.ts";
import { ModelCheck } from "../scripts/lib/models.ts";

const FLEET = new URL("./fixtures/agents/", import.meta.url).pathname;
const TEMPLATE_ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_POLICY = { agents: CheapModelAgents.LowEffort, canEditFiles: false };
const OFF_POLICY = { agents: CheapModelAgents.None, canEditFiles: false };
const available = () => ({ kind: ModelCheck.Available }) as const;
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash";

function setup(names = ["codebase-scout", "log-digger", "test-runner", "docs-researcher"]): ExternalPaths {
  const root = mkdtempSync(join(tmpdir(), "boomerang-"));
  const paths: ExternalPaths = {
    claudeAgentsDir: join(root, "claude-agents"),
    opencodeAgentsDir: join(root, "opencode-agents"),
    originalsDir: join(root, "boomerang", "originals"),
    launcherPath: join(root, "data", "bin", "boomerang"),
    templateRoot: TEMPLATE_ROOT,
  };
  mkdirSync(paths.claudeAgentsDir, { recursive: true });
  for (const name of names) copyFileSync(join(FLEET, `${name}.md`), join(paths.claudeAgentsDir, `${name}.md`));
  return paths;
}

const read = (path: string) => readFileSync(path, "utf8");
const original = (name: string) => read(join(FLEET, `${name}.md`));

test("sync saves the original, writes the proxy and the OpenCode agent", () => {
  const paths = setup();
  const result = sync(paths, DEFAULT_POLICY, available);
  assert.deepEqual(result.changes.sort(), [
    "codebase-scout: now runs on the cheap model",
    "log-digger: now runs on the cheap model",
  ]);
  assert.equal(read(join(paths.originalsDir, "codebase-scout.md")), original("codebase-scout"));
  const proxy = parseAgent(join(paths.claudeAgentsDir, "codebase-scout.md"));
  assert.equal(proxy.frontmatter["boomerang-proxy"], "true");
  assert.ok(proxy.body.includes(`'${paths.launcherPath}' delegate codebase-scout`));
  assert.ok(read(join(paths.opencodeAgentsDir, "codebase-scout.md")).includes("mode: all"));
  assert.equal(read(join(paths.claudeAgentsDir, "test-runner.md")), original("test-runner"), "untouched");
  assert.equal(existsSync(join(paths.opencodeAgentsDir, "test-runner.md")), false);
});

test("sync with the rule off restores the original byte for byte and removes the OpenCode agent", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const result = sync(paths, OFF_POLICY, available);
  assert.ok(result.changes.includes("codebase-scout: back on Claude"));
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
  assert.equal(existsSync(join(paths.opencodeAgentsDir, "codebase-scout.md")), false);
  assert.equal(existsSync(join(paths.originalsDir, "codebase-scout.md")), false);
});

test("sync is idempotent and never saves the proxy over the original", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const proxyFile = join(paths.claudeAgentsDir, "codebase-scout.md");
  const before = statSync(proxyFile).mtimeMs;
  const second = sync(paths, DEFAULT_POLICY, available);
  assert.deepEqual(second.changes, []);
  assert.equal(statSync(proxyFile).mtimeMs, before);
  assert.equal(read(join(paths.originalsDir, "codebase-scout.md")), original("codebase-scout"));
});

test("a re-copied fleet file becomes the new original, and the proxy comes back", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const updated = original("codebase-scout").replace("Returns paths", "Returns only paths");
  writeFileSync(join(paths.claudeAgentsDir, "codebase-scout.md"), updated);
  sync(paths, DEFAULT_POLICY, available);
  assert.equal(read(join(paths.originalsDir, "codebase-scout.md")), updated);
  assert.equal(parseAgent(join(paths.claudeAgentsDir, "codebase-scout.md")).frontmatter["boomerang-proxy"], "true");
});

test("pin writes the key into the original, and auto removes it", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  pin(paths, "log-digger", "claude");
  sync(paths, DEFAULT_POLICY, available);
  const restored = parseAgent(join(paths.claudeAgentsDir, "log-digger.md"));
  assert.equal(restored.frontmatter["boomerang-runtime"], "claude");
  assert.equal(restored.frontmatter["boomerang-proxy"], undefined, "back on Claude");

  pin(paths, "log-digger", "auto");
  sync(paths, DEFAULT_POLICY, available);
  assert.equal(read(join(paths.originalsDir, "log-digger.md")), original("log-digger"), "exactly the original again");
  assert.throws(() => pin(paths, "no-such-agent", "claude"), /no agent named no-such-agent/);
});

test("an unavailable model keeps every agent on Claude and says why", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const result = sync(paths, DEFAULT_POLICY, () => ({
    kind: ModelCheck.Unavailable,
    reason: "OpenCode is not installed",
  }));
  assert.equal(result.modelProblem, "OpenCode is not installed");
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
  assert.equal(existsSync(join(paths.opencodeAgentsDir, "log-digger.md")), false);
});

test("the user's own OpenCode agent with the same name is never overwritten", () => {
  const paths = setup(["codebase-scout"]);
  mkdirSync(paths.opencodeAgentsDir, { recursive: true });
  writeFileSync(
    join(paths.opencodeAgentsDir, "codebase-scout.md"),
    "---\ndescription: mine\nmode: all\n---\nmy agent\n",
  );
  const result = sync(paths, DEFAULT_POLICY, available);
  assert.deepEqual(result.changes, []);
  assert.ok(result.skipped.some((s) => s.includes("OpenCode already has its own agent named codebase-scout")));
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
});

test("list shows each agent with its runtime, reason and model", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const rows = listAgents(paths, DEFAULT_POLICY, MODEL).join("\n");
  assert.match(rows, /codebase-scout +opencode +low effort, read-only +openrouter\/deepseek\/deepseek-v4\.1-flash/);
  assert.match(rows, /docs-researcher +claude +needs MCP tools/);
  assert.match(rows, /test-runner +claude +medium effort +claude-sonnet-5/);
});

test("two files with the same name are both left alone, and no original is lost", () => {
  const paths = setup(["codebase-scout"]);
  const copy = original("codebase-scout").replace("Returns paths", "OLD COPY returns paths");
  writeFileSync(join(paths.claudeAgentsDir, "scout-old.md"), copy);
  const result = sync(paths, DEFAULT_POLICY, available);
  assert.deepEqual(result.changes, []);
  assert.ok(result.skipped.some((s) => s.includes("codebase-scout.md, scout-old.md") && s.includes("same name")));
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
  assert.equal(read(join(paths.claudeAgentsDir, "scout-old.md")), copy);
});

test("originals are keyed by file name, so a file named unlike its agent round-trips", () => {
  const paths = setup([]);
  writeFileSync(join(paths.claudeAgentsDir, "my-scout.md"), original("codebase-scout"));
  sync(paths, DEFAULT_POLICY, available);
  assert.equal(read(join(paths.originalsDir, "my-scout.md")), original("codebase-scout"));
  sync(paths, OFF_POLICY, available);
  assert.equal(read(join(paths.claudeAgentsDir, "my-scout.md")), original("codebase-scout"));
  pin(paths, "codebase-scout", "claude");
  assert.ok(read(join(paths.claudeAgentsDir, "my-scout.md")).includes("boomerang-runtime: claude"));
});

test("when the model cannot be checked, every agent stays exactly as it is", () => {
  const paths = setup();
  sync(paths, DEFAULT_POLICY, available);
  const proxyBefore = read(join(paths.claudeAgentsDir, "codebase-scout.md"));
  const result = sync(paths, DEFAULT_POLICY, () => ({
    kind: ModelCheck.Unknown,
    reason: "`opencode models` timed out",
  }));
  assert.deepEqual(result.changes, []);
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), proxyBefore);
  assert.ok(existsSync(join(paths.opencodeAgentsDir, "codebase-scout.md")));

  const fresh = setup(["codebase-scout"]);
  const unknownFirst = sync(fresh, DEFAULT_POLICY, () => ({ kind: ModelCheck.Unknown, reason: "timed out" }));
  assert.deepEqual(unknownFirst.changes, [], "no proxy is created while the model is unknown");
  assert.equal(read(join(fresh.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
});

test("a second sync while one is running does nothing", () => {
  const paths = setup();
  mkdirSync(join(paths.originalsDir, ".."), { recursive: true });
  writeFileSync(join(paths.originalsDir, "..", "sync.lock"), String(process.pid));
  const result = sync(paths, DEFAULT_POLICY, available);
  assert.deepEqual(result, { changes: [], skipped: [] });
  assert.equal(read(join(paths.claudeAgentsDir, "codebase-scout.md")), original("codebase-scout"));
});

test("pin rejects names that are not plain agent names", () => {
  const paths = setup();
  assert.throws(() => pin(paths, "../../etc/passwd", "claude"), /not a valid agent name/);
});
