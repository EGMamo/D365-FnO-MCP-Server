import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { discoverVisualStudioWorkspace, selectVisualStudioProject } from '../workspace/visualStudio.js';
import { resolveModelTarget } from '../workspace/models.js';
import { metadataProvenance, workspaceCapabilities } from '../workspace/capabilities.js';
import { canonicalRoot, contained, errorMessage } from '../workspace/safety.js';

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

  const searchDir = packagesDir.replace(/\\/g, '/');
  const matches = await glob(`${searchDir}/**/Ax{Table,Class,Enum,Form,Query,DataEntityView,Edt}/*.xml`, {
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

async function checkDbOpen(dbPath: string): Promise<CheckResult> {
  try {
    const { openDb } = await import('../indexer/db.js');
    const db = openDb(dbPath);
    db.close();
    return { name: 'db-open', status: 'pass', message: `Opened SQLite DB at ${dbPath}` };
  } catch (err) {
    return { name: 'db-open', status: 'fail', message: `Cannot open SQLite DB: ${String(err)}` };
  }
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

function checkApiKey(apiKey: string | undefined): CheckResult {
  if (!apiKey) {
    return {
      name: 'api-key',
      status: 'warn',
      message: 'MCP_API_KEY is not set. Required for the HTTP transport.',
    };
  }
  if (apiKey.length < 32) {
    return {
      name: 'api-key',
      status: 'warn',
      message: `MCP_API_KEY is only ${apiKey.length} characters; at least 32 are required for the HTTP transport.`,
    };
  }
  return { name: 'api-key', status: 'pass', message: 'MCP_API_KEY is set' };
}

export async function runChecks(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult[]> {
  const dbPath = env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const results: CheckResult[] = [checkNode()];

  results.push(...(await checkPackagesDir(env.D365_PACKAGES_DIR)));

  const dbDirResults = checkDb(dbPath);
  results.push(...dbDirResults);
  if (dbDirResults.every((r) => r.status === 'pass')) {
    results.push(await checkDbOpen(dbPath));
  }

  results.push(checkApiKey(env.MCP_API_KEY));
  results.push(...checkVisualStudioIntegration(env));
  return results;
}

/** Runs all environment checks, prints a report, and returns the process exit code. */
export async function doctorCommand(env: NodeJS.ProcessEnv = process.env): Promise<number> {
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
