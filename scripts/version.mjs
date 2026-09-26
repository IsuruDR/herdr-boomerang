// Plain JavaScript on purpose: run.mjs imports this before any .ts file loads,
// and an old Node cannot parse TypeScript.

/**
 * True when version `current` is older than `minimum`.
 * @param {number[]} current [major, minor, patch]
 * @param {number[]} minimum [major, minor, patch]
 * @returns {boolean}
 */
export function isOlderThan(current, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] !== minimum[i]) return current[i] < minimum[i];
  }
  return false;
}
