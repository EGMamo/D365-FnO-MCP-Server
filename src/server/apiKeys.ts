/**
 * Parsing and validation of the HTTP transport's API keys.
 *
 * Dependency-free on purpose: `doctor` and the runtime config both use it,
 * and neither should pull in Express or the MCP SDK to validate a key list.
 */

export interface ApiKeyEntry {
  /** Short label used in logs; never the key itself. */
  name: string;
  key: string;
}

export const MIN_API_KEY_LENGTH = 32;

/** Name of the entry created from the legacy single `MCP_API_KEY` variable. */
export const LEGACY_API_KEY_NAME = 'default';

const NAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
/** Sample values from docs and older `.env.example` files, which are long enough to pass the length check. */
const PLACEHOLDER_KEY = /change-?me/i;

export interface ParsedApiKeys {
  keys: ApiKeyEntry[];
  /** Human-readable problems. Messages name the entry, never the key value. */
  errors: string[];
}

/**
 * Parses `MCP_API_KEYS` (`name=key` entries separated by commas or newlines)
 * plus the legacy `MCP_API_KEY` (added under the name `default`).
 * Invalid entries are reported and left out; valid ones are still returned.
 */
export function parseApiKeys(multi: string | undefined, legacy: string | undefined): ParsedApiKeys {
  const keys: ApiKeyEntry[] = [];
  const errors: string[] = [];
  const seenNames = new Set<string>();
  const seenKeys = new Set<string>();

  const add = (name: string, key: string, label: string): void => {
    if (!NAME_PATTERN.test(name)) {
      errors.push(`${label}: name '${name}' must be 1-64 characters of letters, digits, '.', '_', '@' or '-'.`);
      return;
    }
    if (key.length < MIN_API_KEY_LENGTH) {
      errors.push(`${label}: key for '${name}' is ${key.length} characters; at least ${MIN_API_KEY_LENGTH} are required.`);
      return;
    }
    if (PLACEHOLDER_KEY.test(key)) {
      errors.push(`${label}: key for '${name}' is a documentation placeholder; generate one with \`openssl rand -hex 32\`.`);
      return;
    }
    if (seenNames.has(name)) {
      errors.push(`${label}: duplicate name '${name}'.`);
      return;
    }
    if (seenKeys.has(key)) {
      errors.push(`${label}: key for '${name}' duplicates another entry.`);
      return;
    }
    seenNames.add(name);
    seenKeys.add(key);
    keys.push({ name, key });
  };

  const entries = (multi ?? '')
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  entries.forEach((entry, index) => {
    const label = `MCP_API_KEYS entry ${index + 1}`;
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      errors.push(`${label}: expected the form name=key.`);
      return;
    }
    // Split at the first '=' only so a key may itself contain '='.
    add(entry.slice(0, eq).trim(), entry.slice(eq + 1), label);
  });

  const legacyKey = (legacy ?? '').trim();
  if (legacyKey.length > 0) add(LEGACY_API_KEY_NAME, legacyKey, 'MCP_API_KEY');

  return { keys, errors };
}

/** Comma-separated key names for log lines and doctor output. */
export function describeApiKeys(keys: readonly ApiKeyEntry[]): string {
  return keys.map((entry) => entry.name).join(', ');
}
