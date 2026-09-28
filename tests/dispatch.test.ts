import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handOff, type Spawn } from "../scripts/lib/dispatch.ts";
import {
  DEFAULT_OPTIONS,
  isSubagent,
  type Options,
  optionsFromEnv,
  optionsFromSettings,
  readAdvancedConfig,
  readHookInput,
  USER_CONFIG_KEYS,
  unknownAdvancedKeys,
} from "../scripts/lib/hook-io.ts";
import { fails, fakeHerdr, fixture, ok } from "./helpers/fake-herdr.ts";

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };

function unnamedClaude(): string {
  const agent = JSON.parse(fixture("agent-get-named.json"));
  agent.result.agent.agent = "claude";
  delete agent.result.agent.name;
  return JSON.stringify(agent);
}

function namedClaude(name: string): string {
  const agent = JSON.parse(fixture("agent-get-named.json"));
  agent.result.agent.name = name;
  return JSON.stringify(agent);
}

function herdrWithClaude(claudeAgentJson: string) {
  return fakeHerdr([
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
    [["agent", "get"], { stdout: claudeAgentJson }],
    [["agent", "rename"], ok("agent-rename.json")],
    [["pane", "run"], ok("pane-run.json")],
    [["notification", "show"], ok("notification.json")],
    [["pane", "close"], { stdout: "{}" }],
  ]);
}

function recordingSpawn(): { spawn: Spawn; spawned: string[][] } {
  const spawned: string[][] = [];
  return { spawn: (_command, args) => spawned.push(args), spawned };
}

function baseInput(options: Partial<Options>, env: Record<string, string>) {
  return {
    text: "## Goal\nShip it",
    handoffId: "s1",
    sessionId: "s1",
    cwd: "/repo",
    options: { ...DEFAULT_OPTIONS, ...options },
    dataDir: mkdtempSync(join(tmpdir(), "boomerang-")),
    env,
    pluginRoot: "/plugin",
    resetAfter: 2_000_000_000,
  };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test("the three user-config settings come from the plugin env; the rest from config.json", () => {
  assert.deepEqual(optionsFromEnv({}, {}), DEFAULT_OPTIONS);
  const options = optionsFromEnv(
    { CLAUDE_PLUGIN_OPTION_SWITCH_MODE: "auto", CLAUDE_PLUGIN_OPTION_CHEAP_MODEL: "vercel/google/gemini-3-flash" },
    {
      five_hour_threshold: 70,
      seven_day_threshold: "lots",
      codex_placement: "tab",
      codex_args: "--no-daemon",
      hand_back: false,
      cheap_model_can_edit_files: true,
      delegate_timeout_seconds: 120,
    },
  );
  assert.deepEqual(options, {
    ...DEFAULT_OPTIONS,
    switchMode: "auto",
    cheapModel: "vercel/google/gemini-3-flash",
    thresholds: { five_hour: 70, seven_day: 95 },
    placement: "tab",
    codexArgs: "--no-daemon",
    handBack: false,
    cheapModelCanEditFiles: true,
    delegateTimeoutSeconds: 120,
  });
  assert.equal(optionsFromEnv({ CLAUDE_PLUGIN_OPTION_SWITCH_MODE: "yolo" }, {}).switchMode, "confirm");
});

test("config.json never sets the three user-config settings, so hooks and the launcher agree", () => {
  const options = optionsFromEnv(
    { CLAUDE_PLUGIN_OPTION_SWITCH_MODE: "notify" },
    { switch_mode: "auto", cheap_model: "a/b" },
  );
  assert.equal(options.switchMode, "notify");
  assert.equal(options.cheapModel, DEFAULT_OPTIONS.cheapModel, "cheap_model in config.json is ignored");
  assert.equal(optionsFromSettings({}, { switch_mode: "auto" }).switchMode, DEFAULT_OPTIONS.switchMode);
});

test("only strings, numbers and booleans count in config.json; anything else is the default", () => {
  const options = optionsFromEnv({}, { codex_args: null, codex_placement: ["tab"], hand_back: { no: true } } as never);
  assert.equal(options.codexArgs, "", "a null must not reach Codex as the text 'null'");
  assert.equal(options.placement, DEFAULT_OPTIONS.placement);
  assert.equal(options.handBack, DEFAULT_OPTIONS.handBack);
});

test("a tuning setting in the plugin env is ignored: hooks and the launcher must agree", () => {
  const options = optionsFromEnv({ CLAUDE_PLUGIN_OPTION_FIVE_HOUR_THRESHOLD: "60" }, {});
  assert.equal(options.thresholds.five_hour, DEFAULT_OPTIONS.thresholds.five_hour);
  const fromSettings = optionsFromSettings({ five_hour_threshold: 60 }, {});
  assert.equal(fromSettings.thresholds.five_hour, DEFAULT_OPTIONS.thresholds.five_hour);
});

test("the env path and the settings.json path parse the same way", () => {
  const advanced = { cheap_model_can_edit_files: true, delegate_timeout_seconds: 120 };
  const fromEnv = optionsFromEnv(
    {
      CLAUDE_PLUGIN_OPTION_CHEAP_MODEL_AGENTS: "low- and medium-effort agents",
      CLAUDE_PLUGIN_OPTION_CHEAP_MODEL: "vercel/google/gemini-3-flash",
    },
    advanced,
  );
  const fromSettings = optionsFromSettings(
    { cheap_model_agents: "low- and medium-effort agents", cheap_model: "vercel/google/gemini-3-flash" },
    advanced,
  );
  assert.deepEqual(fromEnv, fromSettings);
  assert.equal(optionsFromSettings({ cheap_model_agents: "everything" }, {}).cheapModelAgents, "low-effort agents");
});

test("config.json is read with a named result: missing, valid or invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "boomerang-"));
  assert.deepEqual(readAdvancedConfig(join(dir, "config.json")), { kind: "missing" });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ hand_back: false }));
  assert.deepEqual(readAdvancedConfig(join(dir, "config.json")), { kind: "valid", values: { hand_back: false } });
  writeFileSync(join(dir, "config.json"), "{ hand_back: no }");
  const invalid = readAdvancedConfig(join(dir, "config.json"));
  assert.equal(invalid.kind, "invalid");
  writeFileSync(join(dir, "config.json"), "[1, 2]");
  assert.equal(readAdvancedConfig(join(dir, "config.json")).kind, "invalid", "a JSON array is not a settings object");
  mkdirSync(join(dir, "folder.json"));
  assert.equal(
    readAdvancedConfig(join(dir, "folder.json")).kind,
    "invalid",
    "a file that cannot be read is not missing",
  );
});

test("unknown keys in config.json are named, so a typo is not silent", () => {
  assert.deepEqual(unknownAdvancedKeys({ five_hour_treshold: 60, hand_back: false, switch_mode: "auto" }), [
    "five_hour_treshold",
    "switch_mode",
  ]);
  assert.deepEqual(unknownAdvancedKeys({ five_hour_threshold: 60 }), []);
});

test("plugin.json declares exactly the three user-config settings", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), [...USER_CONFIG_KEYS].sort());
  assert.deepEqual([...USER_CONFIG_KEYS].sort(), ["cheap_model", "cheap_model_agents", "switch_mode"]);
});

test("hook input parsing and the subagent check", () => {
  assert.deepEqual(readHookInput('{"session_id":"s1"}'), { session_id: "s1" });
  assert.deepEqual(readHookInput("garbage"), {});
  assert.equal(isSubagent({ agent_id: "a1" }), true);
  assert.equal(isSubagent({ session_id: "s1" }), false);
});

test("notify mode saves the handoff and never calls Herdr", () => {
  const { run, calls } = herdrWithClaude(unnamedClaude());
  const { spawn, spawned } = recordingSpawn();
  const input = baseInput({ switchMode: "notify" }, HERDR_ENV);
  const message = handOff({ ...input, run, spawn });
  const handoffPath = join(input.dataDir, "handoffs", "s1.md");
  assert.equal(readFileSync(handoffPath, "utf8"), "## Goal\nShip it\n");
  assert.ok(message.includes(handoffPath));
  assert.ok(message.includes("codex"));
  assert.equal(calls.length, 0);
  assert.equal(spawned.length, 0);
});

test("outside Herdr falls back to notify", () => {
  const { run, calls } = herdrWithClaude(unnamedClaude());
  const { spawn, spawned } = recordingSpawn();
  const message = handOff({ ...baseInput({ switchMode: "confirm" }, {}), run, spawn });
  assert.ok(message.includes("not running inside Herdr"));
  assert.equal(calls.length, 0);
  assert.equal(spawned.length, 0);
});

test("a Herdr failure falls back to notify and does not throw", () => {
  const { run } = fakeHerdr([
    [["agent", "get"], { stdout: namedClaude("isuru-main") }],
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
    [["pane", "split"], fails("pane-run-gone.stderr")],
  ]);
  const { spawn, spawned } = recordingSpawn();
  const message = handOff({ ...baseInput({}, HERDR_ENV), run, spawn });
  assert.ok(message.includes("Herdr failed"));
  assert.equal(spawned.length, 0);
});

test("confirm mode opens a boomerang-codex pane and runs the gate without the literal marker", () => {
  const { run, calls } = herdrWithClaude(unnamedClaude());
  const { spawn, spawned } = recordingSpawn();
  handOff({ ...baseInput({ switchMode: "confirm" }, HERDR_ENV), run, spawn });

  // agent-list.json already has a live "boomerang-codex", so we get the next free name.
  const rename = calls.find((c) => c.args[0] === "pane" && c.args[1] === "rename");
  assert.deepEqual(rename?.args, ["pane", "rename", "w2:p5", "boomerang-codex-2"]);

  const paneRun = calls.find((c) => c.args[0] === "pane" && c.args[1] === "run");
  const gateCommand = paneRun?.args[3] ?? "";
  assert.ok(gateCommand.startsWith(`'${process.execPath}' --no-warnings`), "uses the hook's own Node");
  assert.ok(gateCommand.includes("'/plugin/scripts/run.mjs' gate"));
  assert.ok(gateCommand.includes("--handoff"));
  const gateId = argAfter(spawned[0], "--gate-id") ?? "";
  assert.ok(gateId.length >= 6);
  assert.equal(gateCommand.includes(`BOOMERANG_GATE:${gateId}`), false);
});

test("auto mode opens the pane but runs no gate", () => {
  const { run, calls } = herdrWithClaude(unnamedClaude());
  const { spawn, spawned } = recordingSpawn();
  handOff({ ...baseInput({ switchMode: "auto" }, HERDR_ENV), run, spawn });
  assert.equal(
    calls.some((c) => c.args[0] === "pane" && c.args[1] === "run"),
    false,
  );
  assert.equal(argAfter(spawned[0], "--mode"), "auto");
});

test("an unnamed Claude gets boomerang-claude; a named Claude keeps its name", () => {
  const unnamed = herdrWithClaude(unnamedClaude());
  const first = recordingSpawn();
  handOff({ ...baseInput({}, HERDR_ENV), run: unnamed.run, spawn: first.spawn });
  const claudeRename = unnamed.calls.find((c) => c.args[0] === "agent" && c.args[1] === "rename");
  assert.deepEqual(claudeRename?.args, ["agent", "rename", "w1:p1", "boomerang-claude"]);
  assert.equal(argAfter(first.spawned[0], "--claude-name"), "boomerang-claude");

  const named = herdrWithClaude(namedClaude("isuru-main"));
  const second = recordingSpawn();
  handOff({ ...baseInput({}, HERDR_ENV), run: named.run, spawn: second.spawn });
  assert.equal(
    named.calls.some((c) => c.args[0] === "agent" && c.args[1] === "rename"),
    false,
  );
  assert.equal(argAfter(second.spawned[0], "--claude-name"), "isuru-main");
});

test("the runner gets names, the Codex pane, the report path and the reset time", () => {
  const { run } = herdrWithClaude(unnamedClaude());
  const { spawn, spawned } = recordingSpawn();
  const input = baseInput({ handBack: false, codexArgs: "--no-daemon" }, HERDR_ENV);
  handOff({ ...input, run, spawn });
  const args = spawned[0];
  assert.deepEqual(args.slice(0, 3), ["--no-warnings", "/plugin/scripts/run.mjs", "runner"]);
  assert.equal(argAfter(args, "--codex-pane"), "w2:p5");
  assert.equal(argAfter(args, "--codex-name"), "boomerang-codex-2");
  assert.equal(argAfter(args, "--handoff"), join(input.dataDir, "handoffs", "s1.md"));
  assert.equal(argAfter(args, "--reset-after"), "2000000000");
  assert.equal(argAfter(args, "--hand-back"), "0");
  assert.equal(argAfter(args, "--codex-args"), "--no-daemon");
  assert.equal(existsSync(join(input.dataDir, "handoffs", "s1.prompt.txt")), true);
});

test("a Herdr failure after the pane opened closes the pane and starts no runner", () => {
  const { run, calls } = fakeHerdr([
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
    [["agent", "get"], { stdout: namedClaude("isuru-main") }],
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
    [["pane", "run"], fails("pane-run-gone.stderr")],
    [["pane", "close"], { stdout: "{}" }],
  ]);
  const { spawn, spawned } = recordingSpawn();
  const message = handOff({ ...baseInput({ switchMode: "confirm" }, HERDR_ENV), run, spawn });
  assert.ok(message.includes("Herdr failed"));
  assert.equal(spawned.length, 0);
  assert.deepEqual(calls.at(-1)?.args, ["pane", "close", "w2:p5"]);
});

test("a failed notification does not stop the runner from starting", () => {
  const { run } = fakeHerdr([
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
    [["agent", "get"], { stdout: namedClaude("isuru-main") }],
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
    [["pane", "run"], ok("pane-run.json")],
    [["notification", "show"], fails("pane-run-gone.stderr")],
  ]);
  const { spawn, spawned } = recordingSpawn();
  const message = handOff({ ...baseInput({}, HERDR_ENV), run, spawn });
  assert.equal(spawned.length, 1);
  assert.ok(message.includes("boomerang-codex-2"));
});

test("when Herdr does not see Claude as an agent, the handoff still goes on, without a hand-back target", () => {
  const { run, calls } = fakeHerdr([
    [["agent", "list"], ok("agent-list.json")],
    [["pane", "list"], ok("pane-list.json")],
    [["agent", "get"], fails("agent-get-no-agent.stderr")],
    [["pane", "split"], ok("pane-split.json")],
    [["pane", "rename"], ok("pane-rename.json")],
    [["pane", "run"], ok("pane-run.json")],
    [["notification", "show"], ok("notification.json")],
  ]);
  const { spawn, spawned } = recordingSpawn();
  const message = handOff({ ...baseInput({}, HERDR_ENV), run, spawn });
  assert.equal(argAfter(spawned[0], "--claude-name"), "");
  assert.equal(
    calls.some((c) => c.args[0] === "agent" && c.args[1] === "rename"),
    false,
  );
  assert.ok(message.includes("notification instead of a hand-back"));
});

test("invalid Codex arguments stop before Herdr, with the reason", () => {
  const { run, calls } = herdrWithClaude(unnamedClaude());
  const { spawn } = recordingSpawn();
  const message = handOff({ ...baseInput({ codexArgs: '--sandbox "workspace' }, HERDR_ENV), run, spawn });
  assert.ok(message.includes("Extra Codex arguments are not valid"));
  assert.equal(calls.length, 0);
});
