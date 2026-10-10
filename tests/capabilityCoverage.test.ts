import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_CAPABILITY_NAMES, CapabilityInventorySchema } from '../src/indexer/artifactContract.js';
import {
  CAPABILITY_COVERAGE,
  DEFAULT_REQUIRED_CAPABILITIES,
  computeCapabilityInventory,
  parseRequiredCapabilities,
} from '../src/indexer/capabilityCoverage.js';
import { openDb, upsertLabels, upsertObject, type Database } from '../src/indexer/db.js';

let root: string;
let db: Database;

function addObjects(type: string, count: number): void {
  for (let index = 0; index < count; index++) {
    upsertObject(db, {
      type,
      name: `${type}${index}`,
      package: 'ApplicationSuite',
      model: 'Foundation',
      file_path: path.join(root, type, `${type}${index}.xml`),
      raw_xml: null,
      file_mtime: 1,
    });
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-capability-coverage-'));
  db = openDb(path.join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('capability coverage', () => {
  it('requires by default exactly the capabilities the indexer covers completely, in contract order', () => {
    expect(DEFAULT_REQUIRED_CAPABILITIES).toEqual([]);
    expect(Object.keys(CAPABILITY_COVERAGE)).toEqual([...ARTIFACT_CAPABILITY_NAMES]);
    expect(
      ARTIFACT_CAPABILITY_NAMES.filter((name) => CAPABILITY_COVERAGE[name].completeness === 'absent')
    ).toEqual([]);
  });

  it('counts indexed items per capability and keeps the declared completeness', () => {
    addObjects('Class', 3);
    addObjects('Table', 2);
    addObjects('Edt', 1);
    addObjects('Form', 1);
    addObjects('SecurityRole', 1);
    addObjects('SecurityRoleExtension', 1);
    addObjects('SecurityPrivilege', 2);
    addObjects('MenuItemDisplay', 1);
    upsertLabels(db, [
      { labelId: 'SYS1', value: 'Account' },
      { labelId: 'SYS1', value: 'Konto', language: 'de' },
    ]);

    const inventory = computeCapabilityInventory(db);

    expect(CapabilityInventorySchema.parse(inventory)).toEqual(inventory);
    expect(inventory.codeMetadata).toMatchObject({ completeness: 'partial', itemCount: 3 });
    expect(inventory.dataModelMetadata).toMatchObject({ completeness: 'partial', itemCount: 3 });
    expect(inventory.uiFormPatterns).toMatchObject({ completeness: 'partial', itemCount: 1 });
    expect(inventory.labelsResources).toMatchObject({ completeness: 'partial', itemCount: 2 });
    expect(inventory.extensions).toMatchObject({ completeness: 'partial', itemCount: 1 });
    expect(inventory.securityGraphs).toMatchObject({ completeness: 'partial', itemCount: 5 });
    expect(inventory.reports).toMatchObject({ completeness: 'absent', itemCount: 0 });
    expect(inventory.workflowServiceMetadata).toMatchObject({ completeness: 'absent', itemCount: 0 });

    addObjects('Report', 2);
    addObjects('Service', 1);
    const withNameOnly = computeCapabilityInventory(db);
    expect(withNameOnly.reports).toMatchObject({ completeness: 'partial', itemCount: 2 });
    expect(withNameOnly.workflowServiceMetadata).toMatchObject({ completeness: 'partial', itemCount: 1 });
  });

  it('reports a capability absent when the index holds none of its items', () => {
    addObjects('Class', 1);

    const inventory = computeCapabilityInventory(db);

    expect(inventory.codeMetadata.completeness).toBe('partial');
    expect(inventory.labelsResources).toMatchObject({ completeness: 'absent', itemCount: 0 });
    expect(inventory.securityGraphs).toMatchObject({ completeness: 'absent', itemCount: 0 });
    expect(inventory.dataModelMetadata).toMatchObject({ completeness: 'absent', itemCount: 0 });
  });

  it('needs roles, duties or privileges for a security graph, not just menu items', () => {
    addObjects('MenuItemDisplay', 2);

    expect(computeCapabilityInventory(db).securityGraphs).toMatchObject({ completeness: 'absent', itemCount: 2 });

    addObjects('SecurityDuty', 1);
    expect(computeCapabilityInventory(db).securityGraphs).toMatchObject({ completeness: 'partial', itemCount: 3 });
  });

  it('says how many source files of a capability failed to index', () => {
    addObjects('SecurityRole', 1);
    upsertLabels(db, [{ labelId: 'SYS1', value: 'Account' }]);

    const inventory = computeCapabilityInventory(db, { Label: 2, AxClass: 1 });

    expect(CapabilityInventorySchema.parse(inventory)).toEqual(inventory);
    expect(inventory.labelsResources.completeness).toBe('partial');
    expect(inventory.labelsResources.note).toMatch(/ 2 source files of this kind could not be indexed\.$/);
    expect(inventory.securityGraphs.note).toBe(CAPABILITY_COVERAGE.securityGraphs.note);
  });

  it('parses D365_ARTIFACT_REQUIRED_CAPABILITIES with the defaults when unset', () => {
    expect(parseRequiredCapabilities(undefined)).toEqual([...DEFAULT_REQUIRED_CAPABILITIES]);
    expect(parseRequiredCapabilities('  ')).toEqual([...DEFAULT_REQUIRED_CAPABILITIES]);
    expect(parseRequiredCapabilities(' reports , codeMetadata,reports ')).toEqual(['reports', 'codeMetadata']);
    expect(() => parseRequiredCapabilities(' , ')).toThrow(/names no capabilities/);
    expect(() => parseRequiredCapabilities('codeMetadata,forms')).toThrow(
      /D365_ARTIFACT_REQUIRED_CAPABILITIES contains unknown capabilities: forms/
    );
  });
});
