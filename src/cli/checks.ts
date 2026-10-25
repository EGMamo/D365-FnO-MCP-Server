import fs from 'fs';
import path from 'path';
import { globIterate } from 'glob';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

/**
 * The message of the first check that failed, or null when none did. With `rejectWarnings` a warning counts
 * as well, for a caller that wants a clean result rather than a usable one.
 */
export function firstProblem(results: readonly CheckResult[], options: { rejectWarnings?: boolean } = {}): string | null {
  const problem = results.find((result) => (options.rejectWarnings ? result.status !== 'pass' : result.status === 'fail'));
  return problem?.message ?? null;
}

/** The folder types whose XML shows a folder holds D365 metadata. */
const METADATA_FOLDERS: readonly string[] = ['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntityView', 'Edt'].map(
  (type) => `Ax${type}`
);
const METADATA_PATTERN = `**/Ax{${METADATA_FOLDERS.map((folder) => folder.slice(2)).join(',')}}/*.xml`;

/** The subfolders of `dir` in name order (a link counts; it is read like a folder). A folder that cannot be read has none. */
function subfolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The first XML file of `dir` in name order, or undefined. */
function firstXmlFile(dir: string): string | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.xml'))
      .map((entry) => entry.name)
      .sort()[0];
  } catch {
    return undefined;
  }
}

/**
 * Looks where a packages root keeps its metadata, `<Package>/<Model>/Ax<Type>/*.xml`, and reads only those
 * folders: a few directory reads instead of a walk of the whole tree. The names are sorted, so the same
 * folder always gives the same sample.
 */
function probeMetadata(root: string): string | undefined {
  for (const pkg of subfolders(root)) {
    for (const model of subfolders(path.join(root, pkg))) {
      const modelDir = path.join(root, pkg, model);
      for (const folder of subfolders(modelDir).filter((name) => METADATA_FOLDERS.includes(name))) {
        const file = firstXmlFile(path.join(modelDir, folder));
        if (file !== undefined) return path.join(modelDir, folder, file);
      }
    }
  }
  return undefined;
}

/** For a layout the probe does not see: walks until the first match and stops asking for more. */
async function firstMetadataMatch(root: string): Promise<string | undefined> {
  // cwd, not a pattern prefix: glob syntax in the folder name ([x], {a,b}) must not be read as a pattern.
  for await (const match of globIterate(METADATA_PATTERN, { cwd: root, absolute: true, windowsPathsNoEscape: true })) {
    return match;
  }
  return undefined;
}

export async function checkPackagesDir(packagesDir: string | undefined): Promise<CheckResult[]> {
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

  const sample = probeMetadata(packagesDir) ?? (await firstMetadataMatch(packagesDir));

  if (sample === undefined) {
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
    message: `D365 metadata XML found (e.g. ${path.relative(packagesDir, sample)})`,
  });

  try {
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

export async function checkCustomMetadataDir(dir: string): Promise<CheckResult> {
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
