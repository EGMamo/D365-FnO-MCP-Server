import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

const MIN_NODE_MAJOR = 22;

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
