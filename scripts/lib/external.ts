// Applies the cheap-model rule to the agent files. For each agent the rule sends to OpenCode:
// the original file moves to ~/.claude/boomerang/originals (keyed by its file name), a proxy with
// the same name and description takes its place in ~/.claude/agents, and an OpenCode twin goes to
// ~/.config/opencode/agents. When the rule (or a pin) sends it back, the original returns byte for
// byte. Safety rules, each with a test:
// - originals live outside the plugin data folder, so an uninstall cannot delete them
// - every write is atomic, and only one sync runs at a time (lock file)
// - files that share one `name:` are left alone, so one can never overwrite the other's original
// - when the model cannot be checked, nothing changes
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentDef,
  type CheapModelPolicy,
  isProxy,
  OPENCODE_MARKER,
  parseAgent,
  RUNTIME_KEY,
  Runtime,
  runtimeFor,
  toOpenCode,
  toProxy,
} from "./agentdef.ts";
import { type ModelAvailability, ModelCheck } from "./models.ts";
import { writeTextAtomic } from "./state.ts";

/** Agent names become file names in OpenCode's folder, so only plain names are accepted. */
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STALE_LOCK_MS = 60_000;

export interface ExternalPaths {
  claudeAgentsDir: string;
  opencodeAgentsDir: string;
  originalsDir: string; // its parent folder also holds sync.lock and the salt
  launcherPath: string;
  templateRoot: string;
}

export function defaultPaths(dataDir: string, pluginRoot: string): ExternalPaths {
  return {
    claudeAgentsDir: join(homedir(), ".claude", "agents"),
    opencodeAgentsDir: join(homedir(), ".config", "opencode", "agents"),
    originalsDir: join(homedir(), ".claude", "boomerang", "originals"),
    launcherPath: join(dataDir, "bin", "boomerang"),
    templateRoot: pluginRoot,
  };
}

export interface SyncResult {
  changes: string[]; // one line per agent whose files changed
  skipped: string[]; // agents we could not handle, with the reason
  modelProblem?: string; // set when agents wanted the cheap model but it is not available
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Writes (atomically) only when the content differs. True when it wrote. */
function writeIfChanged(path: string, content: string): boolean {
  if (readOrUndefined(path) === content) return false;
  writeTextAtomic(path, content);
  return true;
}

function agentFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

// --- Lock and token --------------------------------------------------------------------

/** Takes the sync lock, or returns undefined when another sync holds a fresh one. */
function takeLock(paths: ExternalPaths): (() => void) | undefined {
  const lock = join(dirname(paths.originalsDir), "sync.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lock), { recursive: true });
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age < STALE_LOCK_MS) return undefined;
      rmSync(lock, { force: true }); // left behind by a killed sync; try once more
    }
  }
  return undefined;
}

/** A heredoc token per original, stable across syncs, not guessable without the local salt. */
function proxyToken(paths: ExternalPaths, original: AgentDef): string {
  const saltPath = join(dirname(paths.originalsDir), "salt");
  let salt = readOrUndefined(saltPath);
  if (!salt) {
    salt = randomBytes(16).toString("hex");
    writeTextAtomic(saltPath, salt, 0o600);
  }
  return createHash("sha256").update(`${salt}\n${original.text}`).digest("hex").slice(0, 12);
}

// --- Reading the agents ----------------------------------------------------------------

interface AgentEntry {
  file: string; // file name in ~/.claude/agents; originals are keyed by it
  livePath: string;
  live: AgentDef;
  original: AgentDef;
}

/** Parses every agent file. Files we cannot use go to `skipped`, and duplicate names skip every file involved. */
function readAgents(paths: ExternalPaths, skipped: string[]): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const file of agentFiles(paths.claudeAgentsDir).sort()) {
    const livePath = join(paths.claudeAgentsDir, file);
    try {
      const live = parseAgent(livePath);
      const original = isProxy(live) ? savedOriginal(paths, file) : live;
      if (!original) {
        skipped.push(
          `${file}: a proxy without its saved original; restore the agent file from your own copy or backup`,
        );
      } else if (!AGENT_NAME.test(original.name)) {
        skipped.push(`${file}: the name "${original.name}" is not a plain agent name (a-z, 0-9, - and _)`);
      } else {
        entries.push({ file, livePath, live, original });
      }
    } catch (error) {
      skipped.push(`${file}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const byName = new Map<string, AgentEntry[]>();
  for (const entry of entries) byName.set(entry.original.name, [...(byName.get(entry.original.name) ?? []), entry]);
  const duplicates = [...byName.values()].filter((group) => group.length > 1);
  for (const group of duplicates) {
    skipped.push(
      `${group.map((e) => e.file).join(", ")}: these files have the same name "${group[0].original.name}", so boomerang leaves them alone`,
    );
  }
  const duplicated = new Set(duplicates.flat());
  return entries.filter((entry) => !duplicated.has(entry));
}

function savedOriginal(paths: ExternalPaths, file: string): AgentDef | undefined {
  const saved = join(paths.originalsDir, file);
  return existsSync(saved) ? parseAgent(saved) : undefined;
}

// --- Sync ------------------------------------------------------------------------------

export function sync(paths: ExternalPaths, policy: CheapModelPolicy, checkModel: () => ModelAvailability): SyncResult {
  const release = takeLock(paths);
  if (!release) return { changes: [], skipped: [] }; // another session is syncing right now
  try {
    return syncLocked(paths, policy, checkModel);
  } finally {
    release();
  }
}

function syncLocked(paths: ExternalPaths, policy: CheapModelPolicy, checkModel: () => ModelAvailability): SyncResult {
  const result: SyncResult = { changes: [], skipped: [] };
  let model: ModelAvailability | undefined; // checked once, and only if some agent wants it

  for (const { file, livePath, live, original } of readAgents(paths, result.skipped)) {
    const openCodePath = join(paths.opencodeAgentsDir, `${original.name}.md`);
    const existingOpenCode = readOrUndefined(openCodePath);
    const openCodeIsOurs = existingOpenCode === undefined || existingOpenCode.includes(OPENCODE_MARKER);
    let wantsCheapModel = runtimeFor(original, policy).runtime === Runtime.OpenCode;
    if (wantsCheapModel && !openCodeIsOurs) {
      result.skipped.push(
        `${original.name}: OpenCode already has its own agent named ${original.name}; left on Claude`,
      );
      wantsCheapModel = false;
    }
    if (wantsCheapModel) {
      model ??= checkModel();
      if (model.kind === ModelCheck.Unknown) continue; // cannot tell right now: keep this agent as it is
      if (model.kind === ModelCheck.Unavailable) {
        result.modelProblem = model.reason;
        wantsCheapModel = false;
      }
    }

    if (wantsCheapModel) {
      // Order matters: the original is safe on disk before the live file becomes a proxy.
      const saved = writeIfChanged(join(paths.originalsDir, file), original.text);
      const twin = writeIfChanged(openCodePath, toOpenCode(original));
      const proxyText = toProxy(original, paths.launcherPath, paths.templateRoot, proxyToken(paths, original));
      const proxy = writeIfChanged(livePath, proxyText);
      if (saved || twin || proxy) result.changes.push(`${original.name}: now runs on the cheap model`);
      continue;
    }

    // Order matters: the original is back in place before its saved copy is removed.
    const restored = isProxy(live) && writeIfChanged(livePath, original.text);
    if (isProxy(live)) rmSync(join(paths.originalsDir, file), { force: true });
    const removedTwin = existingOpenCode !== undefined && openCodeIsOurs;
    if (removedTwin) rmSync(openCodePath, { force: true });
    if (restored || removedTwin) result.changes.push(`${original.name}: back on Claude`);
  }
  return result;
}

// --- Pin and list ----------------------------------------------------------------------

/** Sets `boomerang-runtime` in the agent's original (claude, opencode), or removes it (auto). */
export function pin(paths: ExternalPaths, name: string, target: "claude" | "opencode" | "auto"): void {
  if (!AGENT_NAME.test(name)) throw new Error(`"${name}" is not a valid agent name`);
  const entry = readAgents(paths, []).find((e) => e.original.name === name);
  if (!entry) throw new Error(`no agent named ${name} in ${paths.claudeAgentsDir}`);
  const originalPath = isProxy(entry.live) ? join(paths.originalsDir, entry.file) : entry.livePath;
  const text = entry.original.withFrontmatter({ [RUNTIME_KEY]: target === "auto" ? undefined : target }).text;
  writeTextAtomic(originalPath, text);
}

/** One row per agent: name, runtime, reason, model. */
export function listAgents(paths: ExternalPaths, policy: CheapModelPolicy, cheapModel: string): string[] {
  const skipped: string[] = [];
  const rows = readAgents(paths, skipped).map(({ original }) => {
    const choice = runtimeFor(original, policy);
    const model = choice.runtime === Runtime.OpenCode ? cheapModel : original.frontmatter.model || "inherit";
    return [original.name, choice.runtime, choice.reason, model];
  });
  const widths = [0, 1, 2].map((i) => Math.max(0, ...rows.map((r) => r[i].length)));
  const lines = rows
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  "));
  return [...lines, ...skipped.map((s) => `skipped: ${s}`)];
}
