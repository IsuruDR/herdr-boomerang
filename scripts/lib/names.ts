// Names for the Herdr panes and agents boomerang creates. Herdr names must match
// [a-z][a-z0-9_-]{0,31}, and a live agent name must be unique.
const PREFIX = "boomerang-";
const MAX_LENGTH = 32;
const SUFFIX_ROOM = "-99".length;

/** "codebase-scout" -> "boomerang-codebase-scout", cut short enough to leave room for a -N suffix. */
export function boomerangName(role: string): string {
  const cleaned = role.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${PREFIX}${cleaned}`.slice(0, MAX_LENGTH - SUFFIX_ROOM);
}

/** `base` when nobody uses it, else the first free `base-2`, `base-3`, ... */
export function freeName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
