import {
  ARTIFACT_CAPABILITY_NAMES,
  type ArtifactCapabilityName,
  type CapabilityInventory,
} from './artifactContract.js';
import type { Database } from './db.js';

/**
 * What the indexer covers for each artifact capability. Bundles declare their
 * capabilities from this table, and the API and the artifact commands require
 * the complete ones by default. The contract forbids calling a partial
 * capability complete, so only what `scanner.ts` and `buildIndex.ts` index in
 * full is marked complete: update this table together with the scanner. No
 * capability is complete yet, so by default nothing is required to be.
 */

type CapabilityStatus = CapabilityInventory[ArtifactCapabilityName];

interface CapabilityCoverage {
  completeness: CapabilityStatus['completeness'];
  /** What `itemCount` counts: indexed object types, label rows, or nothing for an absent capability. */
  counts: readonly string[] | 'labels' | null;
  /** Object types that must be present for the capability not to be absent. Defaults to `counts`. */
  presence?: readonly string[];
  note: string;
}

export const CAPABILITY_COVERAGE: Readonly<Record<ArtifactCapabilityName, CapabilityCoverage>> = {
  codeMetadata: {
    completeness: 'partial',
    counts: ['Class'],
    note:
      'Every AxClass, including interfaces and [ExtensionOf] extension classes, is indexed with method ' +
      'signatures, inheritance and source, and every AxTable with its methods. Form and data entity methods ' +
      'are not indexed as methods (their source is only in the stored element XML), and macro dictionaries ' +
      '(AxMacroDictionary) are not indexed.',
  },
  dataModelMetadata: {
    completeness: 'partial',
    counts: ['Table', 'Edt', 'Enum', 'DataEntity', 'Query'],
    note:
      'Tables (fields, indexes, methods), EDTs, enums, data entities and queries are indexed. Views (AxView), ' +
      'maps (AxMap), composite entities, table collections and table, EDT, enum and data entity extensions are not.',
  },
  uiFormPatterns: {
    completeness: 'partial',
    counts: ['Form'],
    note:
      'Forms are indexed with data sources, control tree, design pattern, pattern version and caption. ' +
      'Form extensions (AxFormExtension), menus (AxMenu) and tiles (AxTile) are not.',
  },
  workflowServiceMetadata: {
    completeness: 'absent',
    counts: null,
    note:
      'Workflow types, approvals, tasks and categories (AxWorkflow*) and services and service groups ' +
      '(AxService, AxServiceGroup) are not indexed.',
  },
  reportingAnalytics: {
    completeness: 'absent',
    counts: null,
    note:
      'Aggregate measurements, aggregate dimensions and KPIs (AxAggregateMeasurement, AxAggregateDimension, ' +
      'AxKPI) are not indexed.',
  },
  labelsResources: {
    completeness: 'partial',
    counts: 'labels',
    note:
      'Every label file (AxLabelFile/LabelResources/<language>/*.label.txt) is indexed in every language, ' +
      'under the label IDs code references. Resources (AxResource images and file content) are not.',
  },
  extensions: {
    completeness: 'partial',
    counts: ['SecurityRoleExtension', 'SecurityDutyExtension'],
    note:
      'Security role and duty extensions are indexed, and [ExtensionOf] classes are indexed as classes. Table, ' +
      'form, enum, EDT, data entity, query and menu item extensions (AxTableExtension, AxFormExtension, ...) are not.',
  },
  reports: {
    completeness: 'absent',
    counts: null,
    note: 'SSRS reports (AxReport) are not indexed; the output menu items that open them are.',
  },
  securityGraphs: {
    completeness: 'partial',
    counts: [
      'SecurityRole',
      'SecurityRoleExtension',
      'SecurityDuty',
      'SecurityDutyExtension',
      'SecurityPrivilege',
      'MenuItemDisplay',
      'MenuItemAction',
      'MenuItemOutput',
    ],
    // Menu items alone are not a security graph.
    presence: ['SecurityRole', 'SecurityDuty', 'SecurityPrivilege'],
    note:
      'Security roles, duties, privileges and their role and duty extensions are indexed with sub-roles, entry ' +
      'point and data entity grants, and the display, action and output menu items they reference. Table and ' +
      'field grants (DirectAccessPermissions) and form control overrides on roles and privileges, code ' +
      'permissions (AxSecurityCodePermission) and security policies (AxSecurityPolicy) are not.',
  },
};

const NOTHING_INDEXED_NOTE = 'The source index holds no items this capability covers.';

/** The capabilities the indexer covers completely, in contract order. */
export const DEFAULT_REQUIRED_CAPABILITIES: readonly ArtifactCapabilityName[] = ARTIFACT_CAPABILITY_NAMES.filter(
  (name) => CAPABILITY_COVERAGE[name].completeness === 'complete'
);

/**
 * Parses `D365_ARTIFACT_REQUIRED_CAPABILITIES` (comma-separated capability
 * names). Unset or blank means `DEFAULT_REQUIRED_CAPABILITIES`.
 */
export function parseRequiredCapabilities(value: string | undefined): ArtifactCapabilityName[] {
  if (!value?.trim()) return [...DEFAULT_REQUIRED_CAPABILITIES];
  const names = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      'D365_ARTIFACT_REQUIRED_CAPABILITIES names no capabilities. Leave it empty for the defaults, or use a ' +
        `comma-separated list of: ${ARTIFACT_CAPABILITY_NAMES.join(', ')}.`
    );
  }
  const allowed = new Set<string>(ARTIFACT_CAPABILITY_NAMES);
  const unknown = names.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `D365_ARTIFACT_REQUIRED_CAPABILITIES contains unknown capabilities: ${unknown.join(', ')}. ` +
        `Use a comma-separated list of: ${ARTIFACT_CAPABILITY_NAMES.join(', ')}.`
    );
  }
  return [...new Set(names)] as ArtifactCapabilityName[];
}

/**
 * The capability inventory a bundle of `db` declares, with item counts read from the index.
 * `errorsByType` lists files the index pass could not read or parse ('Label' for label
 * files); a capability that lost any of them is at most partial.
 */
export function computeCapabilityInventory(
  db: Database,
  errorsByType: Readonly<Record<string, number>> = {}
): CapabilityInventory {
  const rows = db.prepare('SELECT type, COUNT(*) AS count FROM ax_objects GROUP BY type').all() as {
    type: string;
    count: number | bigint;
  }[];
  const objectsByType = new Map(rows.map((row) => [row.type, Number(row.count)]));
  const labels = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM ax_labels').get() as { count: number | bigint }).count
  );

  const countObjects = (types: readonly string[]) =>
    types.reduce((sum, type) => sum + (objectsByType.get(type) ?? 0), 0);

  const inventory = ARTIFACT_CAPABILITY_NAMES.map((name): [ArtifactCapabilityName, CapabilityStatus] => {
    const { completeness, counts, presence, note } = CAPABILITY_COVERAGE[name];
    if (counts === null) return [name, { completeness, note }];
    const itemCount = counts === 'labels' ? labels : countObjects(counts);
    const present = counts === 'labels' ? labels : countObjects(presence ?? counts);
    // An index without any such items carries none of this metadata, whatever the indexer can read.
    if (present === 0) return [name, { completeness: 'absent', itemCount, note: NOTHING_INDEXED_NOTE }];
    const failedTypes = counts === 'labels' ? ['Label'] : counts;
    const failed = failedTypes.reduce((sum, type) => sum + (errorsByType[type] ?? 0), 0);
    if (failed === 0) return [name, { completeness, itemCount, note }];
    return [
      name,
      {
        completeness: completeness === 'complete' ? 'partial' : completeness,
        itemCount,
        note: `${note} ${failed} source files of this kind could not be indexed.`,
      },
    ];
  });
  return Object.fromEntries(inventory) as CapabilityInventory;
}
