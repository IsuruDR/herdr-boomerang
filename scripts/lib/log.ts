// Errors from hooks and the background runner go to <data>/errors.log. A broken plugin must
// never block Claude, so entries catch everything, log it here, and exit 0.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function logError(dataDir: string | undefined, where: string, error: unknown): void {
  if (!dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(join(dataDir, "errors.log"), `${new Date().toISOString()} [${where}] ${detail}\n`);
  } catch {
    // Nowhere left to report to.
  }
}
