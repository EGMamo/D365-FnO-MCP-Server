import fsp from 'node:fs/promises';
import { globIterate } from 'glob';
import { logger } from '../utils/logger.js';
import { contained } from '../workspace/safety.js';

export interface ScannedFile {
  type: string;
  name: string;
  package: string;
  model: string;
  filePath: string;
  mtime: number;
}

const AOT_FOLDERS =
  'Ax{Table,TableExtension,View,Map,Service,ServiceGroup,Report,Menu,MenuExtension,MenuItemDisplayExtension,MenuItemActionExtension,MenuItemOutputExtension,WorkflowType,WorkflowApproval,WorkflowTask,WorkflowAutomatedTask,WorkflowCategory,AggregateMeasurement,AggregateDimension,KPI,FormExtension,EdtExtension,EnumExtension,DataEntityViewExtension,QueryExtension,Class,Enum,Form,Query,DataEntityView,Edt,SecurityRole,SecurityRoleExtension,SecurityDuty,SecurityDutyExtension,SecurityPrivilege,MenuItemDisplay,MenuItemAction,MenuItemOutput}';

// Map AOT folder names to canonical type names used throughout the codebase
const FOLDER_TO_TYPE: Record<string, string> = {
  AxTable: 'Table',
  AxClass: 'Class',
  AxEnum: 'Enum',
  AxForm: 'Form',
  AxQuery: 'Query',
  AxDataEntityViewExtension: 'DataEntityExtension',
  AxDataEntityView: 'DataEntity',  // Note: folder is DataEntityView, type is DataEntity
  AxEdt: 'Edt',
  AxSecurityRole: 'SecurityRole',
  AxSecurityRoleExtension: 'SecurityRoleExtension',
  AxSecurityDuty: 'SecurityDuty',
  AxSecurityDutyExtension: 'SecurityDutyExtension',
  AxSecurityPrivilege: 'SecurityPrivilege',
  AxMenuItemDisplay: 'MenuItemDisplay',
  AxMenuItemAction: 'MenuItemAction',
  AxMenuItemOutput: 'MenuItemOutput',
  AxLabelFile: 'Label',
};

export interface ScanOptions {
  /**
   * Skip files whose real path, with every link and junction resolved, is outside `dir`. For a tree the user
   * does not fully control (a checked-out branch, an ISV repository): a link in it must not get a file from
   * elsewhere on the machine read into the index.
   */
  confined?: boolean;
}

/**
 * Yields every AOT object and label file under `dir`.
 *
 * AOT files sit at a fixed depth below PackagesLocalDirectory
 * (`<Package>/<Model>/Ax<Type>/<Name>.xml`), so the walk only reads those
 * levels and never descends into `bin/`, `XppMetadata/` or other build output,
 * which holds most of the files on a real install. When `dir` is not a
 * packages root (a single package or model folder, say) nothing matches at
 * that depth and the whole tree is searched instead.
 */
export async function* scanPackagesDir(dir: string, options: ScanOptions = {}): AsyncGenerator<ScannedFile> {
  let realRoot: string | null = null;
  if (options.confined) {
    try {
      realRoot = await fsp.realpath(dir);
    } catch {
      return;
    }
  }
  let found = 0;
  for await (const file of scanAt(dir, '*/*/', realRoot)) {
    found++;
    yield file;
  }
  if (found > 0) return;
  yield* scanAt(dir, '**/', realRoot);
}

/** Whether the file's real path stays inside the real root; a link that cannot be resolved does not. */
async function isInside(realRoot: string, filePath: string): Promise<boolean> {
  try {
    return contained(realRoot, await fsp.realpath(filePath));
  } catch {
    return false;
  }
}

async function* scanAt(dir: string, prefix: string, realRoot: string | null): AsyncGenerator<ScannedFile> {
  // The folder goes in as cwd, not into the pattern: a folder name with glob syntax ([x], {a,b}, +(x)) would
  // otherwise be read as a pattern and match nothing, with no error.
  const files = globIterate([
    `${prefix}${AOT_FOLDERS}/*.xml`,
    `${prefix}AxLabelFile/LabelResources/*/*.label.txt`
  ], { cwd: dir, windowsPathsNoEscape: true, stat: true, withFileTypes: true });

  for await (const file of files) {
    const filePath = file.fullpath();
    const mtime = file.mtimeMs;
    // A match can disappear while glob is walking a packages tree being updated.
    if (mtime === undefined) continue;
    if (realRoot !== null && !(await isInside(realRoot, filePath))) {
      logger.debug('Skipped a file whose real path is outside the scanned folder', { filePath });
      continue;
    }

    // Extract info from path
    // Format: .../PackagesLocalDirectory/PackageName/ModelName/Type/Name.xml
    const parts = filePath.split(/\/|\\/);
    
    let type = '';
    let name = '';
    let pkg = '';
    let model = '';

    if (filePath.endsWith('.xml')) {
      const fileName = parts[parts.length - 1];
      const typeDir = parts[parts.length - 2];
      model = parts[parts.length - 3];
      pkg = parts[parts.length - 4];

      name = fileName.replace('.xml', '');
      type = FOLDER_TO_TYPE[typeDir] ?? typeDir.replace('Ax', '');
    } else if (filePath.endsWith('.label.txt')) {
      // Format: .../PackageName/ModelName/AxLabelFile/LabelResources/<language>/<LabelFileId>.<language>.label.txt
      const fileName = parts[parts.length - 1];
      model = parts[parts.length - 5];
      pkg = parts[parts.length - 6];

      name = fileName.replace('.label.txt', '');
      type = 'Label';
    }

    yield {
      type,
      name,
      package: pkg,
      model,
      filePath,
      mtime
    };
  }
}

export interface LabelFileName {
  /** The label file id that `@<LabelFileId>:<LabelId>` references name. */
  labelFileId: string;
  language: string;
}

/** Splits `<LabelFileId>.<language>.label.txt` (for example `SYS.en-US.label.txt`). */
export function parseLabelFileName(filePath: string): LabelFileName {
  const base = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.label\.txt$/i, '');
  const dot = base.indexOf('.');
  if (dot <= 0) return { labelFileId: base, language: 'en-US' };
  return { labelFileId: base.slice(0, dot), language: base.slice(dot + 1) || 'en-US' };
}
