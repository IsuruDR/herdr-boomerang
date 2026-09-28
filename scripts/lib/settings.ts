// Safe edits to ~/.claude/settings.json. Every write keeps all keys we do not own,
// and goes through the one atomic write helper.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./state.ts";

export const PLUGIN_ID = "boomerang@boomerang";
export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export interface StatusLine {
  type: "command";
  command: string;
  [key: string]: unknown;
}

// Settings are open-ended JSON owned by Claude Code; we only type what we touch.
// biome-ignore lint/suspicious/noExplicitAny: the settings file has many keys we do not own
export type Settings = Record<string, any>;

export type OptionValue = string | number | boolean;

/** The settings, or {} when the file does not exist yet. */
export function loadSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return JSON.parse(text);
}

export function pluginOptions(path: string, pluginId: string): Record<string, OptionValue> {
  return loadSettings(path).pluginConfigs?.[pluginId]?.options ?? {};
}

export function setPluginOption(path: string, pluginId: string, key: string, value: OptionValue): void {
  const settings = loadSettings(path);
  settings.pluginConfigs ??= {};
  settings.pluginConfigs[pluginId] ??= {};
  settings.pluginConfigs[pluginId].options ??= {};
  settings.pluginConfigs[pluginId].options[key] = value;
  writeSettings(path, settings);
}

export type StatusLineInstall = { kind: "already_installed" } | { kind: "installed"; previous: StatusLine | undefined }; // previous: what we replaced, if anything

/** Points the status line at our command. Keeps the other statusLine keys, such as padding. */
export function installStatusLine(path: string, command: string): StatusLineInstall {
  const settings = loadSettings(path);
  const previous: StatusLine | undefined = settings.statusLine;
  if (previous?.command === command) return { kind: "already_installed" };
  settings.statusLine = { ...previous, type: "command", command };
  writeSettings(path, settings);
  return { kind: "installed", previous };
}

/**
 * Writes settings.json through a symlink (dotfile repos often link it) and keeps its mode.
 * A plain rename would replace the link with a regular file and reset the permissions.
 */
function writeSettings(path: string, settings: Settings): void {
  let target = path;
  let mode: number | undefined;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o777;
  } catch {
    // The file does not exist yet: create it at `path` with default permissions.
  }
  writeJsonAtomic(target, settings, mode);
}
