// Hook input and plugin options. Three settings are userConfig (shown in /config): hooks get
// them as CLAUDE_PLUGIN_OPTION_<KEY> strings, and commands outside a hook (the launcher's
// `delegate`) read them from settings.json. The tuning settings live only in the optional
// ~/.claude/boomerang/config.json, so a hook and the launcher always see the same values.
// One parser serves every path, with the built-in defaults when a value is missing or not valid.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CheapModelAgents } from "./agentdef.ts";
import type { Placement } from "./herdr.ts";
import type { Thresholds } from "./usage.ts";

export const SwitchMode = { Confirm: "confirm", Auto: "auto", Notify: "notify" } as const;
export type SwitchMode = (typeof SwitchMode)[keyof typeof SwitchMode];

export interface Options {
  switchMode: SwitchMode;
  thresholds: Thresholds;
  placement: Placement;
  codexArgs: string;
  handBack: boolean;
  cheapModelAgents: CheapModelAgents;
  cheapModelCanEditFiles: boolean;
  cheapModel: string;
  delegateTimeoutSeconds: number;
}

/** The userConfig keys in .claude-plugin/plugin.json. A test keeps the two in step. */
export const USER_CONFIG_KEYS: ReadonlySet<string> = new Set(["switch_mode", "cheap_model_agents", "cheap_model"]);

/** The optional tuning file. It sits outside the plugin data folder, so it survives an uninstall. */
export const ADVANCED_CONFIG_PATH = join(homedir(), ".claude", "boomerang", "config.json");

export type SettingValue = string | number | boolean;
export type SettingValues = Record<string, SettingValue>;

/** The file's values are unchecked JSON; the parser accepts only strings, numbers and booleans. */
export type AdvancedConfig =
  | { kind: "missing" }
  | { kind: "valid"; values: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

/** The seven tuning keys that config.json may hold. */
export const ADVANCED_KEYS: ReadonlySet<string> = new Set([
  "five_hour_threshold",
  "seven_day_threshold",
  "codex_placement",
  "codex_args",
  "hand_back",
  "cheap_model_can_edit_files",
  "delegate_timeout_seconds",
]);

/** Keys in config.json that boomerang does not read, so SessionStart can name a typo. */
export function unknownAdvancedKeys(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter((key) => !ADVANCED_KEYS.has(key));
}

export function readAdvancedConfig(path: string = ADVANCED_CONFIG_PATH): AdvancedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: `${path} cannot be read (${code ?? error})` };
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "invalid", reason: `${path} must hold one JSON object` };
    }
    return { kind: "valid", values: parsed };
  } catch (error) {
    return { kind: "invalid", reason: `${path} is not valid JSON (${error instanceof Error ? error.message : error})` };
  }
}

/**
 * The file's values, or {} when it is missing or invalid (defaults apply; SessionStart reports invalid).
 * Tests must pass their own values: this default reads the real ~/.claude/boomerang/config.json.
 */
export function advancedValues(config: AdvancedConfig = readAdvancedConfig()): Record<string, unknown> {
  return config.kind === "valid" ? config.values : {};
}

/** Built-in defaults. The three userConfig defaults must match .claude-plugin/plugin.json. */
export const DEFAULT_OPTIONS: Options = {
  switchMode: SwitchMode.Confirm,
  thresholds: { five_hour: 85, seven_day: 95 },
  placement: "split",
  codexArgs: "",
  handBack: true,
  cheapModelAgents: CheapModelAgents.LowEffort,
  cheapModelCanEditFiles: false,
  cheapModel: "openrouter/deepseek/deepseek-v4.1-flash",
  delegateTimeoutSeconds: 540,
};

// biome-ignore lint/suspicious/noExplicitAny: hook input is Claude Code's JSON; callers read known keys
export type HookInput = Record<string, any>;

export function readHookInput(text: string): HookInput {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Hook input from a subagent has an agent_id. We act only for the main session. */
export function isSubagent(input: HookInput): boolean {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function numberIn(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function booleanOr(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** `option(KEY)` returns the raw value of a setting by its upper-case key, as in CLAUDE_PLUGIN_OPTION_<KEY>. */
function parseOptions(option: (key: string) => string | undefined): Options {
  const cheapModel = option("CHEAP_MODEL");
  return {
    switchMode: oneOf(option("SWITCH_MODE"), Object.values(SwitchMode), DEFAULT_OPTIONS.switchMode),
    thresholds: {
      five_hour: numberIn(option("FIVE_HOUR_THRESHOLD"), 50, 99, DEFAULT_OPTIONS.thresholds.five_hour),
      seven_day: numberIn(option("SEVEN_DAY_THRESHOLD"), 50, 99, DEFAULT_OPTIONS.thresholds.seven_day),
    },
    placement: oneOf<Placement>(option("CODEX_PLACEMENT"), ["split", "tab"], DEFAULT_OPTIONS.placement),
    codexArgs: option("CODEX_ARGS") ?? DEFAULT_OPTIONS.codexArgs,
    handBack: booleanOr(option("HAND_BACK"), DEFAULT_OPTIONS.handBack),
    cheapModelAgents: oneOf(
      option("CHEAP_MODEL_AGENTS"),
      Object.values(CheapModelAgents),
      DEFAULT_OPTIONS.cheapModelAgents,
    ),
    cheapModelCanEditFiles: booleanOr(option("CHEAP_MODEL_CAN_EDIT_FILES"), DEFAULT_OPTIONS.cheapModelCanEditFiles),
    cheapModel: cheapModel?.includes("/") ? cheapModel : DEFAULT_OPTIONS.cheapModel,
    delegateTimeoutSeconds: numberIn(
      option("DELEGATE_TIMEOUT_SECONDS"),
      60,
      580,
      DEFAULT_OPTIONS.delegateTimeoutSeconds,
    ),
  };
}

/** Only strings, numbers and booleans count; null, lists and objects fall back to the default. */
const asText = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/**
 * Where one setting comes from: the three userConfig keys only from userConfig, the tuning keys
 * only from config.json. Neither falls back to the other, so a hook (env) and the launcher
 * (settings.json) can never see different values. Undefined means the parser uses the default.
 */
function lookup(userConfigValue: (key: string) => string | undefined, advanced: Record<string, unknown>) {
  return (upperKey: string): string | undefined => {
    const key = upperKey.toLowerCase();
    return USER_CONFIG_KEYS.has(key) ? userConfigValue(key) : asText(advanced[key]);
  };
}

/** In a hook: userConfig from CLAUDE_PLUGIN_OPTION_*, the rest from config.json. */
export function optionsFromEnv(env: NodeJS.ProcessEnv, advanced: Record<string, unknown> = advancedValues()): Options {
  return parseOptions(lookup((key) => env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`], advanced));
}

/** Outside a hook: userConfig from `pluginConfigs[...].options` in settings.json, the rest from config.json. */
export function optionsFromSettings(
  saved: SettingValues,
  advanced: Record<string, unknown> = advancedValues(),
): Options {
  return parseOptions(lookup((key) => asText(saved[key]), advanced));
}

export function dataDirFromEnv(env: NodeJS.ProcessEnv): string {
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set; boomerang hooks must run as a plugin");
  return dataDir;
}
