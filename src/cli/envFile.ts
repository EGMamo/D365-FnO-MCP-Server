import { parse } from 'dotenv';

/**
 * How `value` has to be written in a `.env` file for `dotenv` to read it back unchanged, or null when
 * no spelling survives. Unquoted, `dotenv` cuts a value at `#`, trims it and strips one pair of
 * surrounding quotes; double quotes expand `\n`, which would corrupt `C:\new\Models`. Single quotes
 * and backticks keep a value verbatim, so those are the only quotes used.
 */
export function quoteEnvValue(value: string): string | null {
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return null;
  if (!/^[\s'"`]|\s$|#/.test(value)) return value;
  // In quotes, a trailing backslash makes dotenv read the closing quote as escaped, and the value then
  // runs into the next entry.
  if (value.endsWith('\\')) return null;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  return null;
}

/** A value that cannot be written to a `.env` file so that it reads back unchanged. Names the key, never the value. */
export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

/**
 * Renders a `.env` file of `entries` under `header`. Throws an `EnvFileError`, naming the key but never the
 * value (it may be a secret), when a value cannot be written or would not read back identically through `dotenv`.
 */
export function renderEnvFile(header: string, entries: ReadonlyArray<readonly [string, string]>): string {
  const lines = entries.map(([key, value]) => {
    const quoted = quoteEnvValue(value);
    if (quoted === null) {
      throw new EnvFileError(`${key} cannot be written to a .env file unchanged: it holds a line break or control character, or needs a quoting that .env files cannot express.`);
    }
    return `${key}=${quoted}`;
  });
  const text = `${[header, ...lines].join('\n')}\n`;

  const parsed = parse(text);
  for (const [key, value] of entries) {
    if (parsed[key] !== value) {
      throw new EnvFileError(`${key} would not read back unchanged from a .env file.`);
    }
  }
  return text;
}
