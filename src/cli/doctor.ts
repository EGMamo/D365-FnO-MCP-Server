import fs from 'fs';
import path from 'path';
import { discoverVisualStudioWorkspace, selectVisualStudioProject } from '../workspace/visualStudio.js';
import { resolveModelTarget } from '../workspace/models.js';
import { metadataProvenance, workspaceCapabilities } from '../workspace/capabilities.js';
import { canonicalRoot, contained, errorMessage } from '../workspace/safety.js';
import { describeApiKeys, parseApiKeys } from '../server/apiKeys.js';
import { z } from 'zod';
import { gatewayConfigSchema } from '../gateway/config.js';
import { classifySdkDrift } from '../indexer/appVersion.js';
import { VERSION } from '../version.js';
import { checkCustomMetadataDir, checkPackagesDir, type CheckResult } from './checks.js';

export type { CheckResult } from './checks.js';

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
          message: 'No objects indexed yet. serve needs an index built by the hosted worker; full local indexes are no longer supported.',
        },
  ];
}

export function checkVisualStudioIntegration(env: NodeJS.ProcessEnv): CheckResult[] {
  const provenance = metadataProvenance(env.D365_CUSTOM_METADATA_DIR, env.D365_PROJECT_DIR);
  const metadataDir = env.D365_CUSTOM_METADATA_DIR || env.D365_PROJECT_DIR;
  const workspaceDir = env.D365_VISUAL_STUDIO_WORKSPACE_DIR;
  // Capabilities matter once write tools or a workspace are in play. A custom metadata folder alone, which every
  // gateway machine has, is neither, so a healthy machine is not left with standing warnings.
  const writeTools = env.D365_ENABLE_WRITE_TOOLS === '1';
  const results: CheckResult[] = [];
  if (writeTools || workspaceDir) {
    results.push({
      name: 'workspace-capabilities', status: 'warn',
      message: JSON.stringify({ ...workspaceCapabilities(), provenance }),
    });
  }
  let customRoot: string | null = null;
  try {
    customRoot = metadataDir ? canonicalRoot(metadataDir) : null;
  } catch (error) {
    // Its own name, so a mistyped custom folder is not blamed on the Visual Studio workspace.
    results.push({ name: 'custom-metadata-dir', status: 'fail', message: `${provenance.source}: ${metadataDir} cannot be used: ${errorMessage(error)}` });
    return results;
  }
  try {
    if (customRoot) {
      results.push({
        name: 'custom-metadata-dir', status: 'pass',
        message: `${provenance.source}: ${metadataDir}; canonical root: ${customRoot}. No write probe performed.`,
      });
    } else if (writeTools) {
      throw new Error('D365_CUSTOM_METADATA_DIR (or legacy D365_PROJECT_DIR) is required for write tools.');
    }
    const workspace = workspaceDir
      ? discoverVisualStudioWorkspace(workspaceDir, env.D365_TARGET_SOLUTION)
      : null;
    const selected = workspace ? selectVisualStudioProject(workspace, undefined, env.D365_TARGET_PROJECT) : null;
    // Without write tools an unset workspace is not a problem, so it is not reported.
    if (workspace || writeTools) {
      results.push({
        name: 'visual-studio-workspace',
        status: !workspace || (workspace.projects.length > 1 && !selected) ? 'warn' : selected ? 'pass' : 'fail',
        message: workspace
          ? `D365_VISUAL_STUDIO_WORKSPACE_DIR: ${workspaceDir}; canonical root: ${workspace.root}; membership: ${workspace.membershipSource}; solution: ${workspace.selectedSolution ?? 'none'}; project: ${selected?.path ?? 'selection required'}.`
          : 'D365_VISUAL_STUDIO_WORKSPACE_DIR is not configured; only metadata-only offline writes can be previewed.',
      });
    }
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
  const registry = env.MCP_KEY_REGISTRY?.trim();
  const registryNote = registry ? `; developer keys from the key registry (MCP_KEY_REGISTRY=${registry}), managed with keys new` : '';
  if (parsed.keys.length === 0) {
    return registry
      ? { name: 'api-keys', status: 'pass', message: `No fixed API keys${registryNote}.` }
      : {
          name: 'api-keys',
          status: 'fail',
          message: 'No API key configured (MCP_API_KEYS or MCP_API_KEY, or a key registry with MCP_KEY_REGISTRY). Required for the HTTP transport.',
        };
  }
  return {
    name: 'api-keys',
    status: 'pass',
    message: `${parsed.keys.length} API key(s) configured: ${describeApiKeys(parsed.keys)}${registryNote}`,
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

/**
 * A server version fit to print. The server it came from may be hostile, so a value that is not a plain identifier
 * (a control character could forge a result line) or is longer than a real version is left out, never cut.
 */
function plainVersion(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : null;
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
    const shown = plainVersion(body?.version);
    const version = shown === null ? '' : ` (version ${shown})`;
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
      const shown = plainVersion(hostedVersion);
      results.push({
        name: 'gateway-version',
        status: skew ? 'warn' : 'pass',
        message: skew
          ? (message ?? 'Gateway and hosted server versions differ.')
          : `Gateway ${VERSION} matches ${shown === null ? 'the hosted server' : `hosted ${shown}`} (major.minor)`,
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

/** The most of a hosted /status answer that is read: a real document is under 1 KiB. */
const STATUS_MAX_BYTES = 64 * 1024;
/** How long /status may take, whatever time the rest of the hosted checks are given: it is a courtesy check. */
const STATUS_MAX_WAIT_MS = 5_000;

/**
 * A text field of a hosted /status answer. The server it came from may be old, new or hostile, so a value
 * that is too long or is not a plain identifier counts as absent. It is never cut: a cut key would escape redaction.
 */
const statusText = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9._:+-]+$/).nullish().catch(null);
const statusTimestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/).nullish().catch(null);

/** Only what `doctor` shows. Unknown fields are ignored, so a newer server can add to the document. */
const hostedStatusSchema = z.object({
  status: statusText(16),
  server: z.object({ version: statusText(64) }).nullish().catch(null),
  index: z.object({ applicationVersion: statusText(64), builtAt: statusTimestamp }).nullish().catch(null),
  artifact: z.object({ bundleId: statusText(128) }).nullish().catch(null),
});

/** Reads at most `maxBytes` of a response body (decoded, so a compressed bomb counts too); null when there is more. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Where the hosted server's `/status` is, from the MCP URL the gateway was given: beside it, so `https://h/mcp`
 * gives `https://h/status` and `https://h/d365/mcp` gives `https://h/d365/status`. Null when the path does not end
 * in `/mcp`: nothing says where the server's other routes are, and the API key must go only where the user pointed
 * the gateway, never to a root path that another application behind the same proxy may own.
 */
function hostedStatusUrl(hostedUrl: string): URL | null {
  const url = new URL(hostedUrl);
  const segments = url.pathname.replace(/\/$/, '').split('/');
  if (segments.at(-1) !== 'mcp') return null;
  segments[segments.length - 1] = 'status';
  url.pathname = segments.join('/');
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * Asks the hosted server which index it serves (`GET /status`, with the key that was just accepted) and compares
 * its application version with `D365_APP_VERSION` when that is set. This check never fails: an older server
 * without the route adds no result at all, and everything else that goes wrong is a warning with fixed wording.
 * Redirects are not followed, which would carry the key to another host.
 */
async function checkHostedIndex(
  settings: { hostedUrl: string; hostedApiKey: string; appVersion: string; upstreamTimeoutMs: number }
): Promise<CheckResult[]> {
  const name = 'gateway-hosted-index';
  const statusUrl = hostedStatusUrl(settings.hostedUrl);
  if (statusUrl === null) return [];
  const origin = statusUrl.origin;
  const warn = (message: string): CheckResult[] => [{ name, status: 'warn', message }];
  const budget = Math.min(settings.upstreamTimeoutMs, STATUS_MAX_WAIT_MS);
  try {
    const response = await fetch(statusUrl, {
      headers: { 'X-API-Key': settings.hostedApiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(budget),
      redirect: 'manual',
    });
    const status = response.status;
    if (status === 404) {
      await response.body?.cancel();
      return [];
    }
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      return warn(`Hosted server at ${origin} answered /status with a redirect (HTTP ${status}); redirects are not followed.`);
    }
    if (status === 401 || status === 403) {
      await response.body?.cancel();
      return warn(`Hosted server at ${origin} answered /status with HTTP ${status} although the API key was accepted for /mcp.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      return warn(`Hosted server at ${origin} answered /status with HTTP ${status}; its index version is unknown.`);
    }

    const unreadable = `Hosted server at ${origin} answered /status with an unreadable document (not JSON, or larger than ${STATUS_MAX_BYTES} bytes); its index version is unknown.`;
    if (!/^application\/json/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      return warn(unreadable);
    }
    const text = await readCapped(response, STATUS_MAX_BYTES);
    if (text === null) return warn(unreadable);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return warn(unreadable);
    }
    const parsed = hostedStatusSchema.safeParse(body);
    if (!parsed.success) return warn(unreadable);

    const { status: reported, server, index, artifact } = parsed.data;
    if (reported === 'starting') {
      return warn(`Hosted server at ${origin} reports it is still starting; its index version is not known yet.`);
    }
    if (!index) {
      return warn(`Hosted server at ${origin} answered /status without a readable index description; its index version is unknown.`);
    }
    const version = index.applicationVersion ?? null;
    const facts =
      `Hosted index: application version ${version ?? 'unknown'}, built ${index.builtAt ?? 'unknown'}; ` +
      `${artifact?.bundleId ? `bundle ${artifact.bundleId}` : 'no artifact bundle'}; server ${server?.version ?? 'unknown'}`;
    if (settings.appVersion === '') return [{ name, status: 'pass', message: facts }];

    // The same classification the server uses for the session instructions: the declared version first, the index second.
    const drift = classifySdkDrift(settings.appVersion, version);
    switch (drift.code) {
      case 'match':
        return [{ name, status: 'pass', message: `${facts}. D365_APP_VERSION matches.` }];
      case 'older-build':
        return warn(`${facts}. D365_APP_VERSION ${drift.clientVersion} is an older release than the hosted index (${drift.indexVersion}); objects the hosted tools return may not exist in your environment.`);
      case 'older-revision':
        return warn(`${facts}. D365_APP_VERSION ${drift.clientVersion} is an older hotfix than the hosted index (${drift.indexVersion}); differences are usually small.`);
      case 'client-newer':
        return warn(`${facts}. D365_APP_VERSION ${drift.clientVersion} is newer than the hosted index (${drift.indexVersion}); elements added after the indexed version are not covered.`);
      case 'client-unknown':
        return [{ name, status: 'pass', message: `${facts}. D365_APP_VERSION is not a four-part version, so it was not compared.` }];
      case 'index-unknown':
        return [{ name, status: 'pass', message: `${facts}. The hosted index records no four-part application version, so D365_APP_VERSION was not compared.` }];
    }
  } catch (error) {
    return warn(`Hosted server at ${origin} ${describeNetworkError(error, budget)} while reading /status.`);
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
  secrets.push(settings.hostedApiKey ?? '', settings.token ?? '');
  const tokenText = settings.token === null ? 'generated on first start and kept beside the local index' : 'from D365_GATEWAY_TOKEN';
  const { hostedUrl, hostedApiKey } = settings;
  if (hostedUrl === null || hostedApiKey === null) {
    return redacted([
      { name: 'gateway-config', status: 'pass', message: `Local mode (custom models only); port ${settings.port}; token ${tokenText}` },
      await checkCustomMetadataDir(settings.customMetadataDir),
      checkLocalIndexPath(settings.localIndexDbPath),
      { name: 'gateway-hosted', status: 'pass', message: 'local mode, no hosted server configured' },
    ]);
  }
  const hosted = { ...settings, hostedUrl, hostedApiKey };
  const origin = new URL(hostedUrl).origin;

  const results: CheckResult[] = [
    {
      name: 'gateway-config',
      status: 'pass',
      message: `Hosted ${hostedUrl}; port ${settings.port}; token ${tokenText}`,
    },
    await checkCustomMetadataDir(settings.customMetadataDir),
    checkLocalIndexPath(settings.localIndexDbPath),
  ];
  const health = await checkHostedHealth(origin, settings.upstreamTimeoutMs);
  results.push(health.result);
  if (health.reachable) {
    const keyResults = await checkHostedKey(hosted);
    results.push(...keyResults);
    // Only once the key is accepted: a server that refused it has nothing to tell, and the key was just proven good.
    if (keyResults[0]?.name === 'gateway-hosted-key' && keyResults[0].status === 'pass') {
      results.push(...(await checkHostedIndex(hosted)));
    }
  } else {
    results.push({ name: 'gateway-hosted-key', status: 'warn', message: 'Not checked: the hosted server is not ready.' });
  }
  return redacted(results);
}

/** Which package runs `doctor`: the developer package has no `serve`, so it never runs the serve checks. */
export type DoctorEdition = 'operator' | 'developer';

/** True when the environment sets up the gateway: a hosted URL, or local mode (a custom-models folder alone). */
function gatewayConfiguredIn(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.D365_HOSTED_MCP_URL?.trim() || env.D365_CUSTOM_METADATA_DIR?.trim() || env.D365_PROJECT_DIR?.trim());
}

export async function runChecks(
  env: NodeJS.ProcessEnv = process.env,
  edition: DoctorEdition = 'operator'
): Promise<CheckResult[]> {
  const dbPath = env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const results: CheckResult[] = [checkNode()];

  // A machine set up for the gateway but with no packages folder runs the gateway only; `serve` is not set up on it.
  const gatewayConfigured = gatewayConfiguredIn(env);
  const serveConfigured = edition === 'operator' && (!gatewayConfigured || Boolean(env.D365_PACKAGES_DIR?.trim()));
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
      message:
        edition === 'developer'
          ? 'Skipped the packages-dir, index and api-keys checks: this package runs the gateway only.'
          : 'Skipped the packages-dir, index and api-keys checks: the gateway is set up and D365_PACKAGES_DIR is not, so only the gateway runs here.',
    });
  }
  results.push(...checkVisualStudioIntegration(env));
  if (gatewayConfigured) results.push(...(await checkGateway(env)));
  return results;
}

/**
 * What to run next, judged from the results; the first rule that applies wins.
 * Serve rules key on `packages-dir` and gateway rules on `gateway-config`, because a gateway-only machine
 * gets a `serve-checks` pass in place of the serve checks. A warning blocks only when it names a missing
 * index or a hosted server that is still starting.
 */
export function nextStep(
  results: readonly CheckResult[],
  env: NodeJS.ProcessEnv,
  options: { envFileExists?: boolean; bin?: string } = {}
): string | null {
  const bin = options.bin ?? 'd365-fno-mcp-server';
  const has = (name: string): boolean => results.some((r) => r.name === name);
  const warned = (name: string): boolean => results.some((r) => r.name === name && r.status === 'warn');

  if (!env.D365_PACKAGES_DIR?.trim() && !gatewayConfiguredIn(env)) {
    // `setup` refuses to replace a .env, so it is no way forward for a folder that already has one.
    return options.envFileExists
      ? `Next: run \`${bin} setup --force\` to write a new .env (it replaces the current one).`
      : `Next: run \`${bin} setup\`.`;
  }
  const failed = [...new Set(results.filter((r) => r.status === 'fail').map((r) => r.name))];
  if (failed.length > 0) {
    return `Next: fix the failed checks above (${failed.join(', ')}), then run \`${bin} doctor\` again.`;
  }
  if (warned('gateway-hosted-health')) {
    return `Next: the hosted server is still starting; run \`${bin} doctor\` again in a moment.`;
  }
  if (warned('db-objects')) {
    const gateway = has('gateway-config') ? ' The gateway needs no index and can start now.' : '';
    return `Next: point D365_INDEX_DB_PATH at an index built by the hosted worker before running \`${bin} serve\`.${gateway}`;
  }
  if (has('packages-dir') && has('gateway-config')) {
    return `Next: run \`${bin} serve\` (server) or \`${bin} gateway\` (custom models, with or without a hosted server).`;
  }
  if (has('packages-dir')) return `Next: run \`${bin} serve\`.`;
  if (has('gateway-config')) return `Next: run \`${bin} gateway\`.`;
  return null;
}

/**
 * Runs all environment checks, prints a report, and returns the process exit code. It ends with a `Next:` line
 * unless `showNext` is false, for a caller that prints its own closing step. `envFileExists` says whether the
 * working folder already has a `.env` (looked up when not given), which changes the advice for an unconfigured machine.
 */
export async function doctorCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: { showNext?: boolean; envFileExists?: boolean; bin?: string; edition?: DoctorEdition } = {}
): Promise<number> {
  const results = await runChecks(env, options.edition ?? 'operator');
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

  if (options.showNext !== false) {
    const next = nextStep(results, env, {
      envFileExists: options.envFileExists ?? fs.existsSync(path.resolve('.env')),
      ...(options.bin ? { bin: options.bin } : {}),
    });
    if (next !== null) console.log(`\n${next}`);
  }

  return failures.length > 0 ? 1 : 0;
}
