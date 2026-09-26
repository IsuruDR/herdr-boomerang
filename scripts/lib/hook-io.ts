// Hook input and plugin options. Hooks get the userConfig values as CLAUDE_PLUGIN_OPTION_<KEY>
// strings; commands outside a hook (the launcher's `delegate`) read them from settings.json.
// One parser serves both, with the manifest defaults when a value is missing or not valid.
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

/** Keep in step with the userConfig defaults in .claude-plugin/plugin.json. */
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

/** `option(KEY)` returns the raw value of a userConfig key (upper-case, as in CLAUDE_PLUGIN_OPTION_<KEY>). */
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

export function optionsFromEnv(env: NodeJS.ProcessEnv): Options {
  return parseOptions((key) => env[`CLAUDE_PLUGIN_OPTION_${key}`]);
}

/** From `pluginConfigs[...].options` in settings.json, where keys are lower-case and values are typed. */
export function optionsFromSettings(saved: Record<string, string | number | boolean>): Options {
  return parseOptions((key) => {
    const value = saved[key.toLowerCase()];
    return value === undefined ? undefined : String(value);
  });
}

export function dataDirFromEnv(env: NodeJS.ProcessEnv): string {
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set; boomerang hooks must run as a plugin");
  return dataDir;
}
