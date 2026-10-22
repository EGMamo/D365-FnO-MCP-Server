import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseApiKeys } from '../server/apiKeys.js';
import { canonicalRoot, errorMessage, isMissing, safeSegment } from '../workspace/safety.js';
import type { GatewayConfig } from './types.js';

/**
 * Pure configuration loading for the hybrid gateway: parses an environment
 * object and either returns the config or throws `GatewayConfigError`. It
 * deliberately does not import `config.ts` (which validates the server's own
 * settings eagerly and exits the process), and it never reads dotenv files;
 * the caller loads those first.
 */

export class GatewayConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Gateway configuration validation failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'GatewayConfigError';
  }
}

const DEFAULT_PORT = 3101;
const DEFAULT_LOCAL_INDEX_DB_PATH = './.d365/custom_index.db';
/** Same default as the server's D365_INDEX_DB_PATH. */
const DEFAULT_MAIN_INDEX_DB_PATH = './d365_index.db';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_REINDEX_TTL_MS = 30_000;
const IN_MEMORY_DB = ':memory:';
const TOKEN_FILE_NAME = 'gateway-token';
/** URL.hostname keeps the brackets around an IPv6 literal. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MCP_PATH = '/mcp';
/**
 * What a private prefix may look like. The router splits every argument into identifiers (merge.ts,
 * containsPrivateName) and compares a prefix with the start of each, so a prefix with any other character,
 * or one starting with a digit, would match nothing and silently filter nothing.
 */
const PRIVATE_PREFIX = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Environment values after zod's string/default handling, before the cross-field checks. */
const gatewayEnvSchema = z.object({
  D365_HOSTED_MCP_URL: z.string().trim().default(''),
  D365_HOSTED_API_KEY: z.string().trim().default(''),
  D365_HOSTED_API_KEY_FILE: z.string().trim().default(''),
  D365_CUSTOM_METADATA_DIR: z.string().trim().default(''),
  /** Legacy alias for D365_CUSTOM_METADATA_DIR, as in the server's configLoader. */
  D365_PROJECT_DIR: z.string().trim().default(''),
  D365_LOCAL_INDEX_DB_PATH: z.string().trim().default(''),
  /** The server's main index; the gateway only compares against it. */
  D365_INDEX_DB_PATH: z.string().trim().default(''),
  /** Optional standard index the custom index is laid over; opened read-only. */
  D365_GATEWAY_STANDARD_INDEX_DB_PATH: z.string().trim().default(''),
  D365_GATEWAY_PORT: z.string().trim().default(''),
  D365_GATEWAY_TOKEN: z.string().trim().default(''),
  D365_APP_VERSION: z.string().trim().default(''),
  D365_GATEWAY_PRIVATE_PREFIXES: z.string().default(''),
  D365_GATEWAY_UPSTREAM_TIMEOUT_MS: z.string().trim().default(''),
  D365_GATEWAY_REINDEX_TTL_MS: z.string().trim().default(''),
  D365_VISUAL_STUDIO_WORKSPACE_DIR: z.string().trim().default(''),
  D365_TARGET_PROJECT: z.string().trim().default(''),
  D365_TARGET_PACKAGE: z.string().trim().default(''),
  D365_TARGET_MODEL: z.string().trim().default(''),
  D365_TARGET_SOLUTION: z.string().trim().default(''),
  D365_WRITABLE_MODELS: z.string().default(''),
});

type GatewayEnv = z.output<typeof gatewayEnvSchema>;

/** The validated settings; `token` is null until `loadGatewayConfig` generates or reads one. */
type ValidatedGatewayEnv = Omit<GatewayConfig, 'token' | 'tokenFile'> & { token: string | null };

type ReportIssue = (variable: string, message: string) => void;

function parseHostedUrl(raw: string, issue: ReportIssue): string {
  const name = 'D365_HOSTED_MCP_URL';
  if (!raw) {
    issue(name, 'is required: the hosted MCP endpoint, e.g. https://<host>/mcp');
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issue(name, 'must be an absolute URL such as https://<host>/mcp');
    return '';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    issue(name, 'must use https:// (plain http:// is accepted only for 127.0.0.1, localhost and ::1)');
    return '';
  }
  if (url.username || url.password) {
    issue(name, 'must not contain credentials; use D365_HOSTED_API_KEY or D365_HOSTED_API_KEY_FILE');
    return '';
  }
  if (url.pathname === '/') url.pathname = MCP_PATH;
  return url.toString();
}

/**
 * Resolves the hosted API key from exactly one source. Problems never quote the
 * key, nor the key file's path (a key pasted into the _FILE variable would
 * otherwise be echoed back).
 */
function resolveHostedApiKey(env: GatewayEnv, issue: ReportIssue): string {
  const inline = env.D365_HOSTED_API_KEY;
  const file = env.D365_HOSTED_API_KEY_FILE;
  if (inline && file) {
    issue('D365_HOSTED_API_KEY', 'set either D365_HOSTED_API_KEY or D365_HOSTED_API_KEY_FILE, not both');
    return '';
  }
  if (!inline && !file) {
    issue('D365_HOSTED_API_KEY', 'is required: set D365_HOSTED_API_KEY or D365_HOSTED_API_KEY_FILE');
    return '';
  }

  let key = inline;
  let name = 'D365_HOSTED_API_KEY';
  if (file) {
    name = 'D365_HOSTED_API_KEY_FILE';
    try {
      key = fs.readFileSync(path.resolve(file), 'utf8').trim();
    } catch (err) {
      issue(name, `cannot read the key file (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`);
      return '';
    }
    if (!key) {
      issue(name, 'the key file is empty');
      return '';
    }
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    issue(name, 'the key must be a single line without control characters');
    return '';
  }
  return key;
}

function resolveCustomMetadataDir(env: GatewayEnv, issue: ReportIssue): string {
  const name = env.D365_CUSTOM_METADATA_DIR ? 'D365_CUSTOM_METADATA_DIR' : 'D365_PROJECT_DIR';
  const configured = env.D365_CUSTOM_METADATA_DIR || env.D365_PROJECT_DIR;
  if (!configured) {
    issue('D365_CUSTOM_METADATA_DIR', 'is required: the folder holding your custom models (legacy alias: D365_PROJECT_DIR)');
    return '';
  }
  try {
    return canonicalRoot(configured);
  } catch (err) {
    issue(name, isMissing(err) ? `directory does not exist: ${path.resolve(configured)}` : errorMessage(err));
    return '';
  }
}

/** Absolute form of a DB path, following symlinks of the file or its parent directory when they exist. */
function canonicalDbPath(file: string): string {
  const absolute = path.resolve(file);
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolute);
  } catch {
    try {
      canonical = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      canonical = absolute;
    }
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** The custom index must never be the server's main index: building it would prune that one. */
function resolveLocalIndexDbPath(env: GatewayEnv, issue: ReportIssue): string {
  const configured = env.D365_LOCAL_INDEX_DB_PATH || DEFAULT_LOCAL_INDEX_DB_PATH;
  if (configured === IN_MEMORY_DB) return configured;
  const resolved = path.resolve(configured);
  const main = env.D365_INDEX_DB_PATH || DEFAULT_MAIN_INDEX_DB_PATH;
  if (main !== IN_MEMORY_DB && canonicalDbPath(resolved) === canonicalDbPath(main)) {
    issue('D365_LOCAL_INDEX_DB_PATH', 'must differ from D365_INDEX_DB_PATH; the custom index is kept apart from the main index');
  }
  return resolved;
}

/** The standard index must be an existing file, read-only to the gateway, and never the custom index itself. */
function resolveStandardIndexDbPath(env: GatewayEnv, localIndexDbPath: string, issue: ReportIssue): string | null {
  const name = 'D365_GATEWAY_STANDARD_INDEX_DB_PATH';
  const configured = env.D365_GATEWAY_STANDARD_INDEX_DB_PATH;
  if (!configured) return null;
  if (configured === IN_MEMORY_DB) {
    issue(name, 'must be the file of an index built with the index command, not :memory:');
    return null;
  }
  const resolved = path.resolve(configured);
  let isFile = false;
  try {
    isFile = fs.statSync(resolved).isFile();
  } catch (err) {
    issue(name, isMissing(err) ? `file does not exist: ${resolved}` : errorMessage(err));
    return null;
  }
  if (!isFile) {
    issue(name, `is not a file: ${resolved}`);
    return null;
  }
  if (localIndexDbPath !== IN_MEMORY_DB && canonicalDbPath(resolved) === canonicalDbPath(localIndexDbPath)) {
    issue(name, 'must differ from D365_LOCAL_INDEX_DB_PATH; the standard index is read-only and the custom index is laid over it');
    return null;
  }
  return resolved;
}

function parseIntegerSetting(
  env: GatewayEnv,
  name: keyof GatewayEnv,
  range: { min: number; max: number; fallback: number },
  issue: ReportIssue
): number {
  const raw = env[name];
  if (!raw) return range.fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < range.min || value > range.max) {
    issue(name, `must be an integer from ${range.min} to ${range.max}`);
    return range.fallback;
  }
  return value;
}

/** Problems with a token, worded for `parseApiKeys`' rules (length, placeholder) plus no whitespace. */
function tokenProblems(token: string): string[] {
  const problems = parseApiKeys(undefined, token).errors.map((error) =>
    error.replace(/^MCP_API_KEY: key for 'default' /, 'token ')
  );
  if (!token) problems.push('token is empty');
  if (/\s/.test(token)) problems.push('token must not contain whitespace');
  return problems;
}

function parseToken(raw: string, issue: ReportIssue): string | null {
  if (!raw) return null;
  const problems = tokenProblems(raw);
  for (const problem of problems) issue('D365_GATEWAY_TOKEN', problem);
  return problems.length === 0 ? raw : null;
}

/** The comma-separated prefixes; an entry the name filter could never match is reported by position, not echoed. */
function parsePrivatePrefixes(raw: string, issue: ReportIssue): string[] {
  const prefixes = raw.split(',').map((prefix) => prefix.trim()).filter(Boolean);
  let valid = true;
  prefixes.forEach((prefix, index) => {
    if (PRIVATE_PREFIX.test(prefix)) return;
    valid = false;
    issue(
      'D365_GATEWAY_PRIVATE_PREFIXES',
      `entry ${index + 1} is not a plain name prefix, so it would never match: use letters, digits and underscores, starting with a letter or underscore (no wildcards, "@", ":" or ".")`
    );
  });
  return valid ? prefixes : [];
}

/** Comma-separated literal Package/Model pairs, validated as the server validates them. */
function parseWritableModels(value: string, issue: ReportIssue): string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    try {
      const parts = entry.split('/');
      if (parts.length !== 2) throw new Error('Expected Package/Model.');
      parts.forEach(safeSegment);
    } catch {
      issue('D365_WRITABLE_MODELS', `Invalid writable target '${entry}'; use comma-separated literal Package/Model pairs (spaces allowed).`);
    }
  }
  return entries;
}

/**
 * Everything the gateway reads from the environment. Validation lives in one
 * transform so that every problem is reported together; zod would otherwise
 * skip the cross-field checks once a single field failed.
 */
export const gatewayConfigSchema = gatewayEnvSchema.transform((env, ctx): ValidatedGatewayEnv => {
  let failed = false;
  const issue: ReportIssue = (variable, message) => {
    failed = true;
    ctx.addIssue({ code: 'custom', path: [variable], message });
  };

  const customMetadataDir = resolveCustomMetadataDir(env, issue);
  const localIndexDbPath = resolveLocalIndexDbPath(env, issue);
  const settings: ValidatedGatewayEnv = {
    hostedUrl: parseHostedUrl(env.D365_HOSTED_MCP_URL, issue),
    hostedApiKey: resolveHostedApiKey(env, issue),
    customMetadataDir,
    localIndexDbPath,
    standardIndexDbPath: resolveStandardIndexDbPath(env, localIndexDbPath, issue),
    port: parseIntegerSetting(env, 'D365_GATEWAY_PORT', { min: 1, max: 65_535, fallback: DEFAULT_PORT }, issue),
    host: '127.0.0.1',
    token: parseToken(env.D365_GATEWAY_TOKEN, issue),
    appVersion: env.D365_APP_VERSION,
    privatePrefixes: parsePrivatePrefixes(env.D365_GATEWAY_PRIVATE_PREFIXES, issue),
    upstreamTimeoutMs: parseIntegerSetting(
      env,
      'D365_GATEWAY_UPSTREAM_TIMEOUT_MS',
      { min: 1_000, max: 120_000, fallback: DEFAULT_UPSTREAM_TIMEOUT_MS },
      issue
    ),
    reindexTtlMs: parseIntegerSetting(
      env,
      'D365_GATEWAY_REINDEX_TTL_MS',
      { min: 1_000, max: 3_600_000, fallback: DEFAULT_REINDEX_TTL_MS },
      issue
    ),
    workspace: {
      workspaceDir: env.D365_VISUAL_STUDIO_WORKSPACE_DIR,
      customMetadataDir,
      targetProject: env.D365_TARGET_PROJECT,
      targetPackage: env.D365_TARGET_PACKAGE,
      targetModel: env.D365_TARGET_MODEL,
      targetSolution: env.D365_TARGET_SOLUTION,
      writableModels: parseWritableModels(env.D365_WRITABLE_MODELS, issue),
    },
  };
  return failed ? z.NEVER : settings;
});

/**
 * Returns the token stored next to the local index, creating it on first use.
 * A stored file that fails the token rules is replaced. An in-memory index has
 * no directory to hold the file, so its token lives only for this process.
 */
function loadOrCreateToken(localIndexDbPath: string): { token: string; tokenFile: string | null } {
  if (localIndexDbPath === IN_MEMORY_DB) return { token: randomBytes(32).toString('hex'), tokenFile: null };

  const tokenFile = path.join(path.dirname(localIndexDbPath), TOKEN_FILE_NAME);
  try {
    const stored = fs.readFileSync(tokenFile, 'utf8').trim();
    if (tokenProblems(stored).length === 0) {
      // A file created by hand or by an older tool may be readable by others.
      if (process.platform !== 'win32') fs.chmodSync(tokenFile, 0o600);
      return { token: stored, tokenFile };
    }
  } catch {
    // Missing or unreadable: fall through and write a fresh token.
  }

  const token = randomBytes(32).toString('hex');
  // Written aside and renamed, so a second gateway starting at once never reads a half-written token.
  const staging = `${tokenFile}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(staging, `${token}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, tokenFile);
  } catch (err) {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // Nothing was staged (for example the folder could not be created).
    }
    throw new GatewayConfigError([
      `D365_GATEWAY_TOKEN: cannot store the generated token in ${tokenFile} (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}); ` +
        'make that folder writable or set D365_GATEWAY_TOKEN',
    ]);
  }
  return { token, tokenFile };
}

/**
 * Validates `env` (defaults to `process.env`) or throws one `GatewayConfigError`
 * listing every problem. Without D365_GATEWAY_TOKEN it generates a token and
 * keeps it in `gateway-token` beside the local index. Neither the hosted API
 * key nor the token appears in any error text.
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = gatewayConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new GatewayConfigError(parsed.error.issues.map((problem) => `${problem.path.join('.')}: ${problem.message}`));
  }
  const { token, ...settings } = parsed.data;
  const stored = token === null ? loadOrCreateToken(settings.localIndexDbPath) : { token, tokenFile: null };
  return { ...settings, ...stored };
}
