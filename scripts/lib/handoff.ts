// Everything about the handoff text: the instruction Claude gets, the marker in its reply,
// where the files live, the fallback when Claude could not write one, and the prompts
// for Codex and for the hand-back.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageWindow, WindowName } from "./usage.ts";

export const HANDOFF_MARKER = "<!-- boomerang-handoff -->";

const WINDOW_LABELS: Record<WindowName, string> = { five_hour: "5-hour", seven_day: "7-day" };

/** `over` can be empty for the reminder after a limit window's data went stale; the text stays valid. */
export function instruction(over: UsageWindow[]): string {
  const usage = over.length
    ? over.map((w) => `${WINDOW_LABELS[w.name]} usage is at ${Math.round(w.usedPercentage)}%`).join(", ")
    : "usage is close to its limit";
  return [
    `boomerang: your ${usage}, above the handoff threshold.`,
    "Finish only the smallest safe step you are in. Do not start new work.",
    "Then reply with a handoff for Codex, another coding agent that has none of your context.",
    `Start the reply with this exact line:\n${HANDOFF_MARKER}`,
    "Then write these sections: Goal, Done, In progress, Next steps (numbered and concrete),",
    "Files touched, How to verify, Watch out for. After the handoff, stop.",
  ].join("\n");
}

export function containsHandoff(reply: string | undefined): boolean {
  return (reply ?? "").includes(HANDOFF_MARKER);
}

/** The text after the marker. Call only when containsHandoff(reply) is true. */
export function extractHandoff(reply: string): string {
  return reply.slice(reply.indexOf(HANDOFF_MARKER) + HANDOFF_MARKER.length).trim();
}

export function saveHandoff(dataDir: string, handoffId: string, text: string): string {
  const path = join(dataDir, "handoffs", `${handoffId}.md`);
  mkdirSync(join(dataDir, "handoffs"), { recursive: true });
  writeFileSync(path, `${text}\n`);
  return path;
}

export function reportPath(handoffPath: string): string {
  return handoffPath.replace(/\.md$/, ".report.md");
}

// --- Transcript fallback ---------------------------------------------------------------

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

function parseEntry(line: string): TranscriptEntry | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A main-session user entry. Injected text (isMeta) and subagent entries (isSidechain) do not count. */
function isMainUserEntry(entry: TranscriptEntry): boolean {
  return entry.type === "user" && entry.isMeta !== true && entry.isSidechain !== true;
}

/** Text that Claude Code itself puts into user entries (slash commands, their output, reminders). */
const CLAUDE_CODE_WRAPPER = /^<(command-|local-command-|system-reminder|user-prompt-submit-hook|bash-)/;

/** The text a person typed, or undefined for tool results and Claude Code's own wrapped text. */
function typedText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
  const trimmed = text.trim();
  return trimmed && !CLAUDE_CODE_WRAPPER.test(trimmed) ? trimmed : undefined;
}

/** Only the end of the transcript is read: long sessions reach hundreds of MB, and hooks must be fast. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** The last `maxBytes` of a file as whole lines (the first, partial line is dropped). */
function readTailLines(path: string, maxBytes: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

/** Text the user typed, newest last, from the end of the transcript. */
export function recentUserPrompts(transcriptPath: string, limit = 3): string[] {
  let lines: string[];
  try {
    lines = readTailLines(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return [];
  }
  const prompts = lines
    .map(parseEntry)
    .filter((entry) => entry !== undefined && isMainUserEntry(entry))
    .map((entry) => typedText(entry?.message?.content))
    .filter((text) => text !== undefined);
  return prompts.slice(-limit);
}

/** `git status --short` plus the last commit line, or a note when cwd is not a git repository. */
export function gitStatus(cwd: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: "pipe" });
  try {
    const status = git(["status", "--short"]).trimEnd() || "(clean working tree)";
    const lastCommit = git(["log", "-1", "--oneline"]).trim();
    return `${status}\nLast commit: ${lastCommit}`;
  } catch {
    return "(not a git repository)";
  }
}

/** Handoff for when Claude hit the limit before it wrote one. */
export function fallbackHandoff(transcriptPath: string, prompts: string[], status: string): string {
  const promptList = prompts.length ? prompts.map((p) => `- ${p}`).join("\n") : "- (none found)";
  return [
    "## Goal",
    "Claude Code reached its usage limit before it could write a handoff. Rebuild the state from the sources below.",
    "",
    "## What the user asked most recently",
    promptList,
    "",
    "## Where to look",
    `- Claude's full transcript (JSONL): ${transcriptPath}. Read the last part of it.`,
    "- Check `git diff` first. It shows what Claude changed and did not commit.",
    "",
    "## Git state",
    "```",
    status,
    "```",
  ].join("\n");
}

// --- Prompts ---------------------------------------------------------------------------

export function codexPrompt(handoffPath: string, cwd: string): string {
  return [
    "You are taking over work from Claude Code, which reached its usage limit.",
    `First read the handoff file at ${handoffPath}. The project is ${cwd}.`,
    "Follow the project AGENTS.md. Continue from 'Next steps'. Check `git diff` before you change anything.",
    `When you finish, or when you cannot continue, write a report to ${reportPath(handoffPath)}`,
    "with these sections: What I did, What is left, How I verified, Watch out for.",
    "Claude Code reads this report when it takes the work back.",
  ].join(" ");
}

export function handBackPrompt(report: string, reportExists: boolean): string {
  return reportExists
    ? `boomerang: Codex finished the work you handed off. Read its report at ${report}, review \`git diff\`, then continue the task.`
    : "boomerang: Codex stopped without writing a report. Review `git diff` and `git log` to find what changed since your handoff, then continue the task.";
}
