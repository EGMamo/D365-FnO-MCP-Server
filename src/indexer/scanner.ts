import { glob } from 'glob';
import fs from 'fs/promises';

export interface ScannedFile {
  type: string;
  name: string;
  package: string;
  model: string;
  filePath: string;
  mtime: number;
}

export async function* scanPackagesDir(dir: string): AsyncGenerator<ScannedFile> {
  const searchDir = dir.replace(/\\/g, '/');
  
  const files = await glob([
    `${searchDir}/**/Ax{Table,Class,Enum,Form,Query,DataEntityView,Edt,SecurityRole,SecurityRoleExtension,SecurityDuty,SecurityDutyExtension,SecurityPrivilege,MenuItemDisplay,MenuItemAction,MenuItemOutput}/*.xml`,
    `${searchDir}/**/AxLabelFile/LabelResources/*/*.label.txt`
  ], { windowsPathsNoEscape: true });

  for (const filePath of files) {
    let mtime: number;
    try {
      mtime = (await fs.stat(filePath)).mtimeMs;
    } catch (err) {
      // Deleted between the directory listing and now (a branch switch or a deployment in progress).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    
    // Extract info from path
    // Format: .../PackagesLocalDirectory/PackageName/ModelName/Type/Name.xml
    const parts = filePath.split(/\/|\\/);
    
    let type = '';
    let name = '';
    let pkg = '';
    let model = '';

    // Map AOT folder names to canonical type names used throughout the codebase
    const folderToType: Record<string, string> = {
      AxTable: 'Table',
      AxClass: 'Class',
      AxEnum: 'Enum',
      AxForm: 'Form',
      AxQuery: 'Query',
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

    if (filePath.endsWith('.xml')) {
      const fileName = parts[parts.length - 1];
      const typeDir = parts[parts.length - 2];
      model = parts[parts.length - 3];
      pkg = parts[parts.length - 4];

      name = fileName.replace('.xml', '');
      type = folderToType[typeDir] ?? typeDir.replace('Ax', '');
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
