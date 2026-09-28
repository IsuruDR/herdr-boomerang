// Small shell helpers. Commands we send to a Herdr pane go through the user's shell, so
// every value in them is quoted here.

/** Quotes a value as one word for sh/zsh/bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Splits a user-typed argument string into arguments without running a shell.
 * Handles single quotes, double quotes and backslash escapes: `--sandbox "workspace write"` gives 2 args.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < input.length) {
      current += input[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${input}`);
  if (inWord) args.push(current);
  return args;
}
