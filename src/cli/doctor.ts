import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { discoverVisualStudioWorkspace, selectVisualStudioProject } from '../workspace/visualStudio.js';
import { resolveModelTarget } from '../workspace/models.js';
import { metadataProvenance, workspaceCapabilities } from '../workspace/capabilities.js';
import { canonicalRoot, contained, errorMessage } from '../workspace/safety.js';
import { describeApiKeys, parseApiKeys } from '../server/apiKeys.js';
import { gatewayConfigSchema } from '../gateway/config.js';
import { VERSION } from '../version.js';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

const MIN_NODE_MAJOR = 24;

function checkNode(): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: 'node', status: 'pass', message: `Node ${process.versions.node}` }
    : {
        name: 'node',
        status: 'fail',
        message: `Node ${process.versions.node} detected; >= ${MIN_NODE_MAJOR} is required. Upgrade Node.js.`,
      };
}

function checkDirWritable(dirPath: string): boolean {
  const probe = path.join(dirPath, `.d365-doctor-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function checkPackagesDir(packagesDir: string | undefined): Promise<CheckResult[]> {
  if (!packagesDir) {
    return [
      {
        name: 'packages-dir',
        status: 'fail',
        message: 'D365_PACKAGES_DIR is not set. Run `d365-fno-mcp-server setup` or set it in .env.',
      },
    ];
  }

  if (!fs.existsSync(packagesDir) || !fs.statSync(packagesDir).isDirectory()) {
    return [
      {
        name: 'packages-dir',
        status: 'fail',
        message: `D365_PACKAGES_DIR "${packagesDir}" does not exist or is not a directory.`,
      },
    ];
  }

  const results: CheckResult[] = [
    { name: 'packages-dir', status: 'pass', message: `Found ${packagesDir}` },
  ];

  // cwd, not a pattern prefix: glob syntax in the folder name ([x], {a,b}) must not be read as a pattern.
  const matches = await glob('**/Ax{Table,Class,Enum,Form,Query,DataEntityView,Edt}/*.xml', {
    cwd: packagesDir,
    absolute: true,
    windowsPathsNoEscape: true,
  });

  if (matches.length === 0) {
    results.push({
      name: 'metadata-files',
      status: 'fail',
      message: `No D365 metadata XML found under "${packagesDir}". Point D365_PACKAGES_DIR at PackagesLocalDirectory.`,
    });
    return results;
  }

  results.push({
    name: 'metadata-files',
    status: 'pass',
    message: `${matches.length} metadata XML file(s) found`,
  });

  try {
    const sample = matches[0];
    const content = fs.readFileSync(sample, 'utf-8');
    const { XMLParser } = await import('fast-xml-parser');
    new XMLParser({ ignoreAttributes: false }).parse(content);
    results.push({
      name: 'sample-parse',
      status: 'pass',
      message: `Parsed ${path.basename(sample)}`,
    });
  } catch (err) {
    results.push({
      name: 'sample-parse',
      status: 'warn',
      message: `Sample metadata file could not be parsed: ${String(err)}`,
    });
  }

  return results;
}

function checkDb(dbPath: string): CheckResult[] {
  const results: CheckResult[] = [];
  const dir = path.resolve(path.dirname(dbPath));

  if (!fs.existsSync(dir)) {
    results.push({
      name: 'db-dir',
      status: 'fail',
      message: `Index DB directory "${dir}" does not exist. Create it or change D365_INDEX_DB_PATH.`,
    });
    return results;
  }

  if (!checkDirWritable(dir)) {
    results.push({
      name: 'db-dir',
      status: 'fail',
      message: `Index DB directory "${dir}" is not writable.`,
    });
    return results;
  }

  results.push({ name: 'db-dir', status: 'pass', message: `Writable: ${dir}` });
  return results;
}

async function checkDbOpen(dbPath: string): Promise<CheckResult[]> {
  let objects = 0;
  try {
    const { openDb } = await import('../indexer/db.js');
    const db = openDb(dbPath);
    try {
      objects = Number((db.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number | bigint }).n);
    } finally {
      db.close();
    }
  } catch (err) {
    return [{ name: 'db-open', status: 'fail', message: `Cannot open SQLite DB: ${String(err)}` }];
  }
  return [
    { name: 'db-open', status: 'pass', message: `Opened SQLite DB at ${dbPath}` },
    objects > 0
      ? { name: 'db-objects', status: 'pass', message: `${objects} objects indexed` }
      : {
          name: 'db-objects',
          status: 'warn',
          message: 'No objects indexed yet; run `d365-fno-mcp-server index`.',
        },
  ];
}

export function checkVisualStudioIntegration(env: NodeJS.ProcessEnv): CheckResult[] {
  const capabilities = workspaceCapabilities();
  const provenance = metadataProvenance(env.D365_CUSTOM_METADATA_DIR, env.D365_PROJECT_DIR);
  const results: CheckResult[] = [
    {
      name: 'workspace-capabilities', status: 'warn',
      message: JSON.stringify({ ...capabilities, provenance }),
    },
  ];
  const metadataDir = env.D365_CUSTOM_METADATA_DIR || env.D365_PROJECT_DIR;
  const workspaceDir = env.D365_VISUAL_STUDIO_WORKSPACE_DIR;
  try {
    const customRoot = metadataDir ? canonicalRoot(metadataDir) : null;
    if (customRoot) {
      results.push({
        name: 'custom-metadata-dir', status: 'pass',
        message: `${provenance.source}: ${metadataDir}; canonical root: ${customRoot}. No write probe performed.`,
      });
    } else if (env.D365_ENABLE_WRITE_TOOLS === '1') {
      throw new Error('D365_CUSTOM_METADATA_DIR (or legacy D365_PROJECT_DIR) is required for write tools.');
    }
    const workspace = workspaceDir
      ? discoverVisualStudioWorkspace(workspaceDir, env.D365_TARGET_SOLUTION)
      : null;
    const selected = workspace ? selectVisualStudioProject(workspace, undefined, env.D365_TARGET_PROJECT) : null;
    results.push({
      name: 'visual-studio-workspace',
      status: !workspace || (workspace.projects.length > 1 && !selected) ? 'warn' : selected ? 'pass' : 'fail',
      message: workspace
        ? `D365_VISUAL_STUDIO_WORKSPACE_DIR: ${workspaceDir}; canonical root: ${workspace.root}; membership: ${workspace.membershipSource}; solution: ${workspace.selectedSolution ?? 'none'}; project: ${selected?.path ?? 'selection required'}.`
        : 'D365_VISUAL_STUDIO_WORKSPACE_DIR is not configured; only metadata-only offline writes can be previewed.',
    });
    if (env.D365_TARGET_PROJECT && !selected) throw new Error('Configured target project was not found.');
    if (env.D365_TARGET_SOLUTION && !workspace) throw new Error('Configured target solution requires a workspace.');
    if (selected?.inspection === 'unsupported') {
      results.push({ name: 'project-evaluation', status: 'warn', message: `Offline writes unsupported: ${selected.issues.join(' ')}` });
    }
    const model = env.D365_TARGET_MODEL || selected?.model;
    if (model && selected?.model && model.toLowerCase() !== selected.model.toLowerCase()) {
      throw new Error(`Configured model '${model}' differs from project model '${selected.model}'.`);
    }
    if (customRoot && model) {
      const target = resolveModelTarget(customRoot, model, env.D365_TARGET_PACKAGE,
        env.D365_WRITABLE_MODELS?.split(',').map((entry) => entry.trim()));
      results.push({
        name: 'model-descriptor', status: 'pass',
        message: `Literal descriptor identity: ${target.package}/${target.model}; ${target.descriptor.path}; SHA256 ${target.descriptor.hash}.`,
      });
      results.push({
        name: 'offline-write-authorization', status: target.writable ? 'pass' : 'warn',
        message: target.writable
          ? 'Explicitly allowlisted, unlocked model. Preview/apply and offline acknowledgement still required; compiler not run.'
          : target.writeIssues.join(' '),
      });
      const locks = [path.join(target.modelDir, '.d365-mcp-write.lock'),
        ...(workspace ? [path.join(workspace.root, '.d365-mcp-write.lock')] : [])];
      for (const lock of locks) {
        if (fs.existsSync(lock)) results.push({
          name: 'offline-write-recovery', status: 'fail',
          message: `Active or retained write lock: ${lock}. Do not remove it while a writer is running; inspect journal/backups for manual recovery.`,
        });
      }
    }
    if (env.D365_PACKAGES_DIR && customRoot && contained(canonicalRoot(env.D365_PACKAGES_DIR), customRoot)) {
      results.push({
        name: 'metadata-separation', status: 'warn',
        message: 'Custom metadata overlaps the configured package/index root. Index presence is NOT write authorization; only D365_WRITABLE_MODELS permits existing unlocked targets.',
      });
    }
  } catch (error) {
    results.push({ name: 'visual-studio-workspace', status: 'fail', message: errorMessage(error) });
  }
  return results;
}

/**
 * Invalid API key configuration is always a failure. Missing keys are only
 * tolerated nowhere because the server is HTTP-only.
 */
function checkApiKeys(env: NodeJS.ProcessEnv): CheckResult {
  const parsed = parseApiKeys(env.MCP_API_KEYS, env.MCP_API_KEY);
  if (parsed.errors.length > 0) {
    return { name: 'api-keys', status: 'fail', message: parsed.errors.join(' ') };
  }
  if (parsed.keys.length === 0) {
    return {
      name: 'api-keys',
      status: 'fail',
      message: 'No API key configured (MCP_API_KEYS or MCP_API_KEY). Required for the HTTP transport.',
    };
  }
  return {
    name: 'api-keys',
    status: 'pass',
    message: `${parsed.keys.length} API key(s) configured: ${describeApiKeys(parsed.keys)}`,
  };
}

/** Replaces every secret value in `text`, so a check result never echoes a key or a token. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/** Environment variable behind each option of the hosted connection, for problems it reports. */
const CONNECTION_SETTINGS: Readonly<Record<string, string>> = {
  url: 'D365_HOSTED_MCP_URL',
  apiKey: 'D365_HOSTED_API_KEY',
};

async function checkCustomMetadataDir(dir: string): Promise<CheckResult> {
  const name = 'gateway-custom-dir';
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    return { name, status: 'fail', message: `Custom metadata directory "${dir}" is not readable (${code}).` };
  }
  // The same walk the local index makes; the first hit is enough to show the layout is right.
  const { scanPackagesDir } = await import('../indexer/scanner.js');
  for await (const file of scanPackagesDir(dir)) {
    return {
      name,
      status: 'pass',
      message: `Readable: ${dir}; found ${file.type} ${file.name} in ${file.package}/${file.model}`,
    };
  }
  return {
    name,
    status: 'warn',
    message: `No D365 metadata XML found under "${dir}" (expected <Package>/<Model>/Ax<Type>/*.xml); the local index would be empty.`,
  };
}

function checkLocalIndexPath(dbPath: string): CheckResult {
  const name = 'gateway-local-index';
  if (dbPath === ':memory:') {
    return {
      name,
      status: 'warn',
      message: 'D365_LOCAL_INDEX_DB_PATH is :memory:; the custom index is rebuilt on every start and the gateway token is not kept.',
    };
  }
  const dir = path.dirname(dbPath);
  // The gateway creates missing folders, so the nearest existing one has to accept writes.
  let existing = dir;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (!fs.statSync(existing).isDirectory()) {
    return { name, status: 'fail', message: `Local index directory "${dir}" cannot be created: "${existing}" is not a directory.` };
  }
  if (!checkDirWritable(existing)) {
    return { name, status: 'fail', message: `Local index directory "${existing}" is not writable. Change D365_LOCAL_INDEX_DB_PATH.` };
  }
  if (fs.existsSync(dbPath)) {
    try {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return { name, status: 'fail', message: `Local index file "${dbPath}" is not writable.` };
    }
  }
  const created = existing === dir ? '' : `; "${dir}" will be created`;
  return { name, status: 'pass', message: `Writable: ${dbPath}${created}; separate from the main index` };
}

/** How a failed request to the hosted server is worded; never includes the URL path or a header. */
function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `did not answer within ${timeoutMs} ms`;
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? `is unreachable (${code})` : 'is unreachable';
}

/** The unauthenticated /health of the hosted origin. `reachable` is false when no authenticated call can work either. */
async function checkHostedHealth(origin: string, timeoutMs: number): Promise<{ result: CheckResult; reachable: boolean }> {
  const name = 'gateway-hosted-health';
  try {
    const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (response.status === 503) {
      return {
        result: { name, status: 'warn', message: `Hosted server at ${origin} is starting (HTTP 503); retry in a moment.` },
        reachable: false,
      };
    }
    if (!response.ok) {
      return { result: { name, status: 'fail', message: `Hosted server at ${origin} answered /health with HTTP ${response.status}.` }, reachable: true };
    }
    const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
    const version = typeof body?.version === 'string' ? ` (version ${body.version.slice(0, 64)})` : '';
    return { result: { name, status: 'pass', message: `Hosted server at ${origin} is healthy${version}` }, reachable: true };
  } catch (error) {
    return {
      result: { name, status: 'fail', message: `Hosted server at ${origin} ${describeNetworkError(error, timeoutMs)}.` },
      reachable: false,
    };
  }
}

/** Connects the way the gateway does and lists the hosted tools: proves the key is accepted without changing anything. */
async function checkHostedKey(
  settings: { hostedUrl: string; hostedApiKey: string; upstreamTimeoutMs: number }
): Promise<CheckResult[]> {
  const name = 'gateway-hosted-key';
  const { UpstreamSession, compareVersions } = await import('../gateway/upstream.js');
  let session: InstanceType<typeof UpstreamSession>;
  try {
    session = new UpstreamSession({
      url: settings.hostedUrl,
      apiKey: settings.hostedApiKey,
      timeoutMs: settings.upstreamTimeoutMs,
      gatewayVersion: VERSION,
    });
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const problems = issues?.map((issue) => `${CONNECTION_SETTINGS[String(issue.path[0])] ?? String(issue.path[0])}: ${issue.message}`);
    return [{ name, status: 'fail', message: problems?.join('; ') ?? 'The hosted connection settings cannot be used.' }];
  }
  try {
    const tools = await session.listTools();
    const results: CheckResult[] = [
      { name, status: 'pass', message: `Hosted API key accepted; ${tools.length} tool(s) listed` },
    ];
    const hostedVersion = session.serverVersion;
    if (hostedVersion !== null) {
      const { skew, message } = compareVersions(VERSION, hostedVersion);
      results.push({
        name: 'gateway-version',
        status: skew ? 'warn' : 'pass',
        message: skew ? (message ?? 'Gateway and hosted server versions differ.') : `Gateway ${VERSION} matches hosted ${hostedVersion.slice(0, 64)} (major.minor)`,
      });
    }
    return results;
  } catch (error) {
    // Messages of the session's own errors are built from the host and a fixed reason.
    return [{ name, status: 'fail', message: error instanceof Error ? error.message : 'The hosted server could not be used.' }];
  } finally {
    await session.close();
  }
}

/**
 * Checks for `gateway`: the settings, the folders it reads and writes, and the hosted server with its key.
 * Runs only when D365_HOSTED_MCP_URL is set. It validates through the gateway's own schema but does not
 * load the config, so no token file is created; no result contains the hosted key or the gateway token.
 */
export async function checkGateway(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const secrets = [env.D365_HOSTED_API_KEY ?? '', env.D365_GATEWAY_TOKEN ?? ''].map((secret) => secret.trim());
  const redacted = (results: CheckResult[]): CheckResult[] =>
    results.map((result) => ({ ...result, message: redactSecrets(result.message, secrets) }));

  const parsed = gatewayConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return redacted([{ name: 'gateway-config', status: 'fail', message: problems.join('; ') }]);
  }
  const settings = parsed.data;
  secrets.push(settings.hostedApiKey, settings.token ?? '');
  const origin = new URL(settings.hostedUrl).origin;

  const results: CheckResult[] = [
    {
      name: 'gateway-config',
      status: 'pass',
      message: `Hosted ${settings.hostedUrl}; port ${settings.port}; token ${settings.token === null ? 'generated on first start and kept beside the local index' : 'from D365_GATEWAY_TOKEN'}`,
    },
    await checkCustomMetadataDir(settings.customMetadataDir),
    checkLocalIndexPath(settings.localIndexDbPath),
  ];
  const health = await checkHostedHealth(origin, settings.upstreamTimeoutMs);
  results.push(health.result);
  if (health.reachable) {
    results.push(...(await checkHostedKey(settings)));
  } else {
    results.push({ name: 'gateway-hosted-key', status: 'warn', message: 'Not checked: the hosted server is not ready.' });
  }
  return redacted(results);
}

export async function runChecks(
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult[]> {
  const dbPath = env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const results: CheckResult[] = [checkNode()];

  // A machine with the hosted URL but no packages folder runs the gateway only; `serve` is not set up on it.
  const gatewayConfigured = Boolean(env.D365_HOSTED_MCP_URL?.trim());
  const serveConfigured = !gatewayConfigured || Boolean(env.D365_PACKAGES_DIR?.trim());
  if (serveConfigured) {
    results.push(...(await checkPackagesDir(env.D365_PACKAGES_DIR)));

    const dbDirResults = checkDb(dbPath);
    results.push(...dbDirResults);
    if (dbDirResults.every((r) => r.status === 'pass')) {
      results.push(...(await checkDbOpen(dbPath)));
    }

    results.push(checkApiKeys(env));
  } else {
    results.push({
      name: 'serve-checks',
      status: 'pass',
      message: 'Skipped the packages-dir, index and api-keys checks: D365_HOSTED_MCP_URL is set and D365_PACKAGES_DIR is not, so only the gateway runs here.',
    });
  }
  results.push(...checkVisualStudioIntegration(env));
  if (gatewayConfigured) results.push(...(await checkGateway(env)));
  return results;
}

/** Runs all environment checks, prints a report, and returns the process exit code. */
export async function doctorCommand(
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const results = await runChecks(env);
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;

  console.log('D365 FnO MCP Server — environment check\n');
  for (const r of results) {
    console.log(`  [${icon[r.status]}] ${r.name}: ${r.message}`);
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  console.log(
    `\n${results.length} checks, ${failures.length} failed, ${warnings.length} warning(s).`
  );

  return failures.length > 0 ? 1 : 0;
}
