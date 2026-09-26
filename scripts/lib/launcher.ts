// Installs ${CLAUDE_PLUGIN_DATA}/bin/boomerang, the stable entry point for callers outside the
// plugin (the status line command in settings.json, and the proxy agents in v8).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./shell.ts";

const TEMPLATE_PLACEHOLDER = "__BOOMERANG_DATA_DIR__";

/** Escapes a value for use inside double quotes in sh. */
function shDoubleQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Writes plugin_root (the current plugin version) and the launcher script.
 * Rewrites the launcher only when its content changed. Returns the launcher path.
 * `templateRoot` is where templates/launcher.sh lives; it defaults to the plugin root.
 */
export function installLauncher(pluginRoot: string, dataDir: string, templateRoot = pluginRoot): string {
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(join(dataDir, "plugin_root"), pluginRoot);

  const launcher = join(dataDir, "bin", "boomerang");
  const template = readFileSync(join(templateRoot, "templates", "launcher.sh"), "utf8");
  // A function, not a string, so "$&"-style patterns in the path are never expanded by replace().
  const script = template.replace(TEMPLATE_PLACEHOLDER, () => shDoubleQuoted(dataDir));
  if (readOrEmpty(launcher) !== script) {
    writeFileSync(launcher, script);
    chmodSync(launcher, 0o755);
  }
  return launcher;
}

/** The statusLine command that setup writes to settings.json. SessionStart compares against it. */
export function statusLineCommand(dataDir: string): string {
  return `${shellQuote(join(dataDir, "bin", "boomerang"))} statusline`;
}
