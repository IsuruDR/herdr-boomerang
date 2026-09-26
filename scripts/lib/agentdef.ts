// Agent definition files: Claude Code subagents in ~/.claude/agents, and their OpenCode twins.
// We parse only the flat YAML that agent files use (`key: value`, comma lists, `- item` lists).
// Values stay as the raw text from the file, so a rewritten file parses exactly like the original.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./shell.ts";

export const PROXY_KEY = "boomerang-proxy";
export const RUNTIME_KEY = "boomerang-runtime";
export const OPENCODE_MARKER = "<!-- managed by boomerang -->";

export class AgentDef {
  readonly path: string;
  readonly text: string;
  readonly frontmatter: Record<string, string>;
  readonly body: string;
  private readonly frontmatterLines: string[];
  private readonly blockLists: Record<string, string[]>;

  constructor(path: string, text: string, frontmatterLines: string[], body: string) {
    this.path = path;
    this.text = text;
    this.frontmatterLines = frontmatterLines;
    this.body = body;
    this.frontmatter = {};
    this.blockLists = {};
    let listKey: string | undefined;
    for (const line of frontmatterLines) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey) {
        this.blockLists[listKey].push(item[1].trim());
        continue;
      }
      if (/^\s/.test(line)) continue; // nested map lines (for example OpenCode's permission block)
      const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (!pair) continue;
      const [, key, value] = pair;
      this.frontmatter[key] = value.trim();
      listKey = value.trim() === "" ? key : undefined;
      if (listKey) this.blockLists[listKey] = [];
    }
  }

  get name(): string {
    return this.frontmatter.name;
  }

  /** A list value: a `- item` block, or a comma list split at the top level only (Agent(a, b) stays whole). */
  list(key: string): string[] {
    if (this.blockLists[key]?.length) return this.blockLists[key];
    return splitTopLevel(this.frontmatter[key] ?? "");
  }

  /** The file text with frontmatter keys set (string) or removed (undefined). Other lines stay as they are. */
  withFrontmatter(changes: Record<string, string | undefined>): { text: string } {
    let lines = [...this.frontmatterLines];
    for (const [key, value] of Object.entries(changes)) {
      const at = lines.findIndex((line) => line.startsWith(`${key}:`));
      if (value === undefined) {
        if (at >= 0) lines = lines.filter((_, i) => i !== at);
      } else if (at >= 0) {
        lines[at] = `${key}: ${value}`;
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    return { text: `---\n${lines.join("\n")}\n---\n${this.body}` };
  }
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseAgentText(path: string, text: string): AgentDef {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: no frontmatter block`);
  const agent = new AgentDef(path, text, match[1].split("\n"), match[2]);
  // OpenCode agent files (they have `mode`) take their name from the file name; Claude agents need `name`.
  if (!agent.name && !agent.frontmatter.mode) throw new Error(`${path}: frontmatter has no name`);
  return agent;
}

export function parseAgent(path: string): AgentDef {
  return parseAgentText(path, readFileSync(path, "utf8"));
}

// --- The runtime rule ------------------------------------------------------------------

export const Runtime = { Claude: "claude", OpenCode: "opencode" } as const;
export type Runtime = (typeof Runtime)[keyof typeof Runtime];

export interface RuntimeChoice {
  runtime: Runtime;
  reason: string; // shown by `/boomerang:external list`, for example "low effort, read-only"
}

export const CheapModelAgents = {
  None: "none",
  LowEffort: "low-effort agents",
  LowAndMediumEffort: "low- and medium-effort agents",
} as const;
export type CheapModelAgents = (typeof CheapModelAgents)[keyof typeof CheapModelAgents];

export interface CheapModelPolicy {
  agents: CheapModelAgents;
  canEditFiles: boolean;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const MAX_CHEAP_EFFORT: Record<CheapModelAgents, string | undefined> = {
  [CheapModelAgents.None]: undefined,
  [CheapModelAgents.LowEffort]: "low",
  [CheapModelAgents.LowAndMediumEffort]: "medium",
};

/** Claude Code's default effort when a file sets none. */
function effortOf(agent: AgentDef): string {
  return agent.frontmatter.effort || "medium";
}

/** No `tools` key means the agent gets every tool, MCP tools included. */
function inheritsAllTools(agent: AgentDef): boolean {
  return agent.frontmatter.tools === undefined;
}

function usesMcpTools(agent: AgentDef): boolean {
  return agent.frontmatter.mcpServers !== undefined || agent.list("tools").some((tool) => tool.startsWith("mcp__"));
}

/** Agents that preload Claude Code skills (superpowers and similar) lose them in OpenCode. */
function preloadsSkills(agent: AgentDef): boolean {
  return agent.list("skills").length > 0;
}

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** Read-only when Write and Edit are denied, or when a tools allowlist has no write tool. */
function canEditFiles(agent: AgentDef): boolean {
  const denied = new Set(agent.list("disallowedTools"));
  if (denied.has("Write") && denied.has("Edit")) return false;
  const allowed = agent.list("tools");
  if (allowed.length > 0 && !allowed.some((tool) => WRITE_TOOLS.includes(tool))) return false;
  return true;
}

/** `description: >-` or `|` starts a multi-line value, which our line parser cannot copy. */
function hasPlainDescription(agent: AgentDef): boolean {
  return !/^[>|][+-]?\d*$/.test(agent.frontmatter.description ?? "");
}

/** A twin with one of these names would replace OpenCode's own agent. */
const OPENCODE_BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore"]);

function effortIsCheap(effort: string, maxCheapEffort: string | undefined): boolean {
  if (maxCheapEffort === undefined) return false;
  const rank = EFFORT_ORDER.indexOf(effort);
  return rank >= 0 && rank <= EFFORT_ORDER.indexOf(maxCheapEffort);
}

/**
 * Where an agent runs. The checks go from "cannot work in OpenCode" (never overridden) to the
 * user's master switch, then a pin, then the effort rule.
 */
export function runtimeFor(agent: AgentDef, policy: CheapModelPolicy): RuntimeChoice {
  const claude = (reason: string): RuntimeChoice => ({ runtime: Runtime.Claude, reason });
  if (inheritsAllTools(agent)) return claude("inherits all tools, including MCP tools");
  if (usesMcpTools(agent)) return claude("needs MCP tools that OpenCode does not have");
  if (preloadsSkills(agent)) return claude("preloads Claude Code skills");
  if (!hasPlainDescription(agent)) return claude("description format not supported (use one line)");
  if (OPENCODE_BUILT_IN_AGENTS.has(agent.name)) return claude("name is taken by an OpenCode built-in agent");
  if (policy.agents === CheapModelAgents.None) return claude("cheap model is off");
  const pin = agent.frontmatter[RUNTIME_KEY];
  if (pin === Runtime.Claude || pin === Runtime.OpenCode) return { runtime: pin, reason: `pinned to ${pin}` };
  const effort = effortOf(agent);
  if (!effortIsCheap(effort, MAX_CHEAP_EFFORT[policy.agents])) return claude(`${effort} effort`);
  const edits = canEditFiles(agent);
  if (edits && !policy.canEditFiles) return claude("edits files");
  return { runtime: Runtime.OpenCode, reason: `${effort} effort, ${edits ? "edits files" : "read-only"}` };
}

// --- Generated files -------------------------------------------------------------------

export function isProxy(agent: AgentDef): boolean {
  return agent.frontmatter[PROXY_KEY] === "true";
}

/** The OpenCode twin of a Claude agent. `mode: all` because `opencode run --agent` hangs on `subagent`. */
export function toOpenCode(agent: AgentDef): string {
  const permission = canEditFiles(agent) ? [] : ["permission:", "  edit: deny"];
  return [
    "---",
    `description: ${agent.frontmatter.description}`,
    "mode: all",
    ...permission,
    "---",
    OPENCODE_MARKER,
    "You run inside OpenCode for a Claude Code main agent. Your final message is the report it receives.",
    "",
    agent.body.trim(),
    "",
  ].join("\n");
}

/** The Claude Code proxy that replaces an agent sent to OpenCode: same name and description, so routing is unchanged. */
/**
 * `token` goes into the heredoc delimiter, so a task line cannot end the heredoc early and run as
 * a command. It must not be guessable from the task; external.ts derives it from a secret salt.
 */
export function toProxy(agent: AgentDef, launcherPath: string, templateRoot: string, token: string): string {
  const template = readFileSync(join(templateRoot, "templates", "proxy-agent.md"), "utf8");
  const values: Record<string, string> = {
    name: agent.name,
    description: agent.frontmatter.description ?? "",
    color: agent.frontmatter.color || "gray",
    launcher: shellQuote(launcherPath),
    token,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}
