import { loadObjectXml } from '../indexer/sourceFiles.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import * as dbUtils from '../indexer/db.js';
import { parseAxDataEntityDetails, parseAxTableKeys, type AxTableIndexDetail, type AxTableKeys } from '../indexer/parser.js';
import { findSecurityPaths } from '../security/model.js';
import { resolveLabel, validateNaming } from '../validation/grounding.js';
import { READ_ONLY_TOOL } from './annotations.js';
import { fail, ok, okClass, xmlCommentSafe, xmlEscape, type ToolResult } from './generators.js';
import { withGeneratedFiles, type GeneratedFile } from './generatedFiles.js';

const XMLNS = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';
const GRANT_ORDER = ['Read', 'Update', 'Create', 'Correct', 'Delete', 'Invoke'] as const;
type GrantLevel = (typeof GRANT_ORDER)[number];
const SECURABLE_TYPES = ['MenuItemDisplay', 'MenuItemAction', 'MenuItemOutput', 'DataEntity'] as const;
type SecurableType = (typeof SECURABLE_TYPES)[number];
const UNEXPOSED_FIELD_TYPES = new Set(['Container', 'Blob']);

interface IndexedObject {
  name: string;
  type: string;
  package: string;
  file_path: string;
  raw_xml: string | null;
  fields: { name: string; type: string | null; edt: string | null }[];
  properties: Record<string, string>;
}

function getObject(db: Database, name: string, type: string): IndexedObject | null {
  return dbUtils.getObjectByName(db, name, type) as IndexedObject | null;
}

interface TableField {
  name: string;
  type: string;
  edt: string;
  declaredOn: string;
}

/** Fields of a table including those inherited through `Extends`, keyed by lower-case name. */
function tableFields(db: Database, table: IndexedObject): Map<string, TableField> {
  const result = new Map<string, TableField>();
  const seen = new Set<string>();
  let current: IndexedObject | null = table;
  while (current && !seen.has(current.name.toLowerCase())) {
    seen.add(current.name.toLowerCase());
    for (const f of current.fields) {
      const key = f.name.toLowerCase();
      if (!result.has(key)) {
        result.set(key, { name: f.name, type: f.type ?? '', edt: f.edt ?? '', declaredOn: current.name });
      }
    }
    const parent: string = current.properties.extends ?? '';
    current = parent ? getObject(db, parent, 'Table') : null;
  }
  return result;
}

const isUnique = (i: AxTableIndexDetail) => i.enabled && !i.allowDuplicates && i.fields.length > 0;

/** The index an entity key should mirror: replacement key, then alternate key, then primary or any unique index. */
export function chooseNaturalKey(keys: AxTableKeys): { index: AxTableIndexDetail; reason: string } | null {
  const byName = (n: string) => keys.indexes.find((i) => i.name.toLowerCase() === n.toLowerCase());
  const replacement = keys.replacementKey ? byName(keys.replacementKey) : undefined;
  if (replacement && isUnique(replacement)) return { index: replacement, reason: 'table ReplacementKey' };
  const alternate = keys.indexes.find((i) => i.alternateKey && isUnique(i));
  if (alternate) return { index: alternate, reason: 'alternate key index' };
  const primary = keys.primaryIndex ? byName(keys.primaryIndex) : undefined;
  if (primary && isUnique(primary)) return { index: primary, reason: 'table PrimaryIndex' };
  const unique = keys.indexes.find(isUnique);
  return unique ? { index: unique, reason: 'first unique index' } : null;
}

/** Other data entities already using a public entity or collection name. */
function publicNameOwners(db: Database, value: string, exclude?: string): { entity: string; property: string }[] {
  return (
    db
      .prepare(
        `SELECT o.name AS entity, p.key AS property FROM ax_properties p
         JOIN ax_objects o ON o.id = p.object_id
         WHERE o.type = 'DataEntity' AND p.key IN ('publicEntityName', 'publicCollectionName')
           AND lower(p.value) = lower(?)`
      )
      .all(value) as { entity: string; property: string }[]
  ).filter((r) => r.entity !== exclude);
}

function json(value: unknown): ToolResult {
  return ok(JSON.stringify(value));
}

function fileBlock(path: string, xml: string): string {
  return `=== ${path} ===\n${xml}`;
}

/** The files a result's `=== AxType/Name.xml ===` blocks hold, as generated files. */
function filesFromBlocks(text: string): GeneratedFile[] {
  const header = /^=== (Ax[A-Za-z]+)\/([^/\s]+)\.xml ===$/gm;
  const marks = [...text.matchAll(header)];
  return marks.map((mark, i) => {
    const start = mark.index! + mark[0].length + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    return { aotType: mark[1], name: mark[2], content: text.slice(start, end).replace(/\s+$/, '') + '\n' };
  });
}

/** Attaches the files of a block-formatted result (privileges, duties, roles). */
function withFileBlocks(result: ToolResult): ToolResult {
  return result.isError ? result : withGeneratedFiles(result, filesFromBlocks(result.content[0].text));
}

// ---------------------------------------------------------------------------
// check_entity_odata_readiness
// ---------------------------------------------------------------------------

export async function checkEntityODataReadiness(db: Database, entityName: string): Promise<ToolResult> {
  const entity = getObject(db, entityName, 'DataEntity');
  if (!entity) return fail(`DataEntity '${entityName}' was not found in the index.`);

  const blockers: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const xml = await loadObjectXml(entity);
  const details = xml ? parseAxDataEntityDetails(xml) : null;
  if (!details) {
    warnings.push('Entity XML is not stored in the index and the source file is unavailable; key, read-only and field-kind checks were skipped.');
  }

  const props = entity.properties;
  const isPublic = details ? details.isPublic : props.isPublic === 'true';
  const publicEntityName = details?.publicEntityName ?? props.publicEntityName ?? '';
  const publicCollectionName = details?.publicCollectionName ?? props.publicCollectionName ?? '';
  const primaryKey = details?.primaryKey ?? props.primaryKey ?? '';

  if (!isPublic) blockers.push('IsPublic is not Yes, so the entity is not exposed through OData (/data).');
  if (!publicEntityName) blockers.push('PublicEntityName is empty.');
  if (!publicCollectionName) blockers.push('PublicCollectionName is empty; it is the OData entity set name.');
  if (publicEntityName && publicCollectionName && publicEntityName.toLowerCase() === publicCollectionName.toLowerCase()) {
    blockers.push('PublicEntityName and PublicCollectionName must differ.');
  }
  for (const value of [publicEntityName, publicCollectionName].filter(Boolean)) {
    for (const owner of publicNameOwners(db, value, entity.name)) {
      blockers.push(`'${value}' is also the ${owner.property} of entity ${owner.entity}; OData names must be unique.`);
    }
  }

  if (!primaryKey) blockers.push('PrimaryKey is not set; OData needs an entity key.');
  let keyFields: string[] = [];
  if (details && primaryKey) {
    const key = details.keys.find((k) => k.name.toLowerCase() === primaryKey.toLowerCase());
    if (!key) blockers.push(`PrimaryKey '${primaryKey}' does not match any key under Keys.`);
    else if (key.fields.length === 0) blockers.push(`Key '${key.name}' has no fields.`);
    else {
      keyFields = key.fields;
      if (key.fields.some((f) => f.toLowerCase() === 'recid')) {
        warnings.push(`Key '${key.name}' uses RecId; prefer a natural key so external callers can address records.`);
      }
      const entityFieldNames = new Set(entity.fields.map((f) => f.name.toLowerCase()));
      for (const f of key.fields) {
        if (!entityFieldNames.has(f.toLowerCase())) blockers.push(`Key field '${f}' is not a field of the entity.`);
      }
    }
  }

  if (details?.isReadOnly) info.push('IsReadOnly is Yes: OData supports GET only; create, update and delete fail.');
  if (details?.dataManagementEnabled && !details.stagingTable) {
    warnings.push('DataManagementEnabled is Yes but DataManagementStagingTable is empty.');
  }

  const dataSources = (entity as unknown as { dataSources: { name: string; table_name: string }[] }).dataSources ?? [];
  const tablesByDs = new Map<string, Map<string, TableField> | null>();
  for (const ds of dataSources) {
    const table = getObject(db, ds.table_name, 'Table');
    if (!table) {
      warnings.push(`Data source '${ds.name}' uses table '${ds.table_name}', which is not in the index.`);
      tablesByDs.set(ds.name.toLowerCase(), null);
      continue;
    }
    tablesByDs.set(ds.name.toLowerCase(), tableFields(db, table));
    const tableXml = await loadObjectXml(table);
    const tableType = tableXml ? parseAxTableKeys(tableXml).tableType : '';
    if (tableType && tableType !== 'Regular') {
      blockers.push(`Data source '${ds.name}' uses ${tableType} table '${table.name}'; entities must be backed by regular tables.`);
    }
  }

  const unexposed: string[] = [];
  const unmapped: string[] = [];
  for (const f of entity.fields as unknown as { name: string; data_source: string; data_field: string }[]) {
    const kind = details?.fieldKinds[f.name] ?? '';
    if (kind && kind !== 'AxDataEntityViewMappedField') {
      unmapped.push(f.name);
      continue;
    }
    const fields = tablesByDs.get((f.data_source ?? '').toLowerCase());
    const tf = fields?.get((f.data_field ?? '').toLowerCase());
    if (tf && UNEXPOSED_FIELD_TYPES.has(tf.type)) unexposed.push(`${f.name} (${tf.type})`);
  }
  if (unexposed.length) warnings.push(`Container/blob fields are not exposed through OData: ${unexposed.join(', ')}.`);
  if (unmapped.length) info.push(`Computed/unmapped fields (values come from X++, check their performance): ${unmapped.join(', ')}.`);

  const paths = findSecurityPaths(db, { type: 'DataEntity', name: entity.name });
  const privileges = new Map<string, string>();
  for (const p of paths) privileges.set(p.privilege, p.grants);
  const privilegeRows = dbUtils
    .getXrefsTo(db, entity.name, 'DataEntity', undefined, 'entity_permission')
    .map((x) => x.from_name);
  for (const p of privilegeRows) {
    if (!privileges.has(p)) {
      privileges.set(p, dbUtils.getSecurityGrants(db, p).find((g) => g.target_name === entity.name)?.grants ?? '');
    }
  }
  const roles = [...new Set(paths.map((p) => p.role))].sort();
  if (privileges.size === 0) {
    warnings.push('No indexed privilege grants this entity; only System administrator could call it. Use create_security_privilege or create_readonly_role_for_entities.');
  } else if (roles.length === 0) {
    warnings.push('Privileges grant this entity, but no indexed role reaches them.');
  }

  return json({
    entity: entity.name,
    package: entity.package,
    ready: blockers.length === 0,
    odata: publicCollectionName ? { entitySet: publicCollectionName, url: `/data/${publicCollectionName}` } : null,
    publicEntityName,
    primaryKey: primaryKey ? { name: primaryKey, fields: keyFields } : null,
    isReadOnly: details?.isReadOnly ?? null,
    blockers,
    warnings,
    info,
    security: {
      privileges: [...privileges].map(([privilege, grants]) => ({ privilege, grants })).sort((a, b) => a.privilege.localeCompare(b.privilege)),
      roles,
    },
  });
}

// ---------------------------------------------------------------------------
// create_data_entity
// ---------------------------------------------------------------------------

export interface DataEntitySpec {
  table: string;
  entityName: string;
  fields?: string[];
  keyFields?: string[];
  publicEntityName?: string;
  publicCollectionName?: string;
  readOnly?: boolean;
  entityCategory?: string;
  label?: string;
}

export async function generateDataEntityXml(db: Database, spec: DataEntitySpec): Promise<ToolResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const naming = validateNaming(spec.entityName);
  if (!naming.ok) return fail(`Invalid entity name: ${naming.error}`);
  if (getObject(db, spec.entityName, 'DataEntity')) {
    return fail(`Grounding failed: a data entity named '${spec.entityName}' already exists in the index.`);
  }

  const table = getObject(db, spec.table, 'Table');
  if (!table) return fail(`Grounding failed: table '${spec.table}' was not found in the index.`);
  const xml = await loadObjectXml(table);
  if (!xml) {
    return fail(`Grounding failed: the XML of table '${table.name}' is not stored in the index and its source file is unavailable, so its keys cannot be read.`);
  }
  const keys = parseAxTableKeys(xml);
  if (keys.tableType !== 'Regular') {
    return fail(`Grounding failed: '${table.name}' is a ${keys.tableType} table; data entities need a regular table.`);
  }

  const available = tableFields(db, table);
  const resolveField = (name: string) => available.get(name.toLowerCase());

  const requested = spec.fields && spec.fields.length > 0
    ? spec.fields
    : [...available.values()].filter((f) => !UNEXPOSED_FIELD_TYPES.has(f.type)).map((f) => f.name);
  if (requested.length === 0) return fail(`Grounding failed: table '${table.name}' has no indexed fields to map.`);

  const selected: TableField[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    const f = resolveField(name);
    if (!f) {
      errors.push(`Field '${name}' does not exist on '${table.name}' or its base tables. System fields such as RecId are not mapped by this generator.`);
      continue;
    }
    if (seen.has(f.name.toLowerCase())) {
      errors.push(`Field '${f.name}' was requested more than once.`);
      continue;
    }
    seen.add(f.name.toLowerCase());
    selected.push(f);
    if (UNEXPOSED_FIELD_TYPES.has(f.type)) warnings.push(`Field '${f.name}' is a ${f.type} field and will not be exposed through OData.`);
  }

  let keyFieldNames: string[];
  if (spec.keyFields && spec.keyFields.length > 0) {
    keyFieldNames = [];
    for (const k of spec.keyFields) {
      const f = resolveField(k);
      if (!f) errors.push(`Key field '${k}' does not exist on '${table.name}'.`);
      else keyFieldNames.push(f.name);
    }
    const covered = keys.indexes.some(
      (i) => isUnique(i) && i.fields.length === keyFieldNames.length &&
        i.fields.every((f) => keyFieldNames.some((k) => k.toLowerCase() === f.toLowerCase()))
    );
    if (!covered && keyFieldNames.length) {
      warnings.push(`No unique index on '${table.name}' has exactly the key fields ${keyFieldNames.join(', ')}; duplicate keys would break OData lookups.`);
    }
  } else {
    const natural = chooseNaturalKey(keys);
    if (!natural) {
      errors.push(`Table '${table.name}' has no unique index to use as the entity key; pass keyFields explicitly.`);
      keyFieldNames = [];
    } else {
      keyFieldNames = natural.index.fields.map((f) => resolveField(f)?.name ?? f);
      notes.push(`Entity key mirrors index '${natural.index.name}' (${natural.reason}): ${keyFieldNames.join(', ')}.`);
    }
  }
  if (keyFieldNames.some((k) => k.toLowerCase() === 'recid')) {
    errors.push('RecId cannot be used as the entity key; use a natural key.');
  }
  for (const k of keyFieldNames) {
    const f = resolveField(k);
    if (f && !seen.has(f.name.toLowerCase())) {
      seen.add(f.name.toLowerCase());
      selected.unshift(f);
      notes.push(`Added key field '${f.name}' to the mapped fields.`);
    }
  }

  const publicEntityName = spec.publicEntityName || spec.entityName.replace(/Entity$/, '') || spec.entityName;
  const publicCollectionName = spec.publicCollectionName || `${publicEntityName}s`;
  for (const [label, value] of [['publicEntityName', publicEntityName], ['publicCollectionName', publicCollectionName]] as const) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) errors.push(`${label} '${value}' is not a valid OData identifier.`);
    for (const owner of publicNameOwners(db, value)) {
      errors.push(`${label} '${value}' is already the ${owner.property} of entity ${owner.entity}.`);
    }
  }
  if (publicEntityName.toLowerCase() === publicCollectionName.toLowerCase()) {
    errors.push('publicEntityName and publicCollectionName must differ.');
  }
  if (!spec.publicCollectionName) notes.push(`PublicCollectionName defaulted to '${publicCollectionName}'; adjust if the plural is irregular.`);

  if (spec.label && spec.label.startsWith('@') && !resolveLabel(db, spec.label)) {
    errors.push(`Label '${spec.label}' was not found in the label index.`);
  }
  if (errors.length > 0) return fail(['Grounding failed:', ...errors]);

  const readOnly = spec.readOnly ?? true;
  const dsName = table.name;
  const fieldXml = selected.map((f) => [
    `    <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">`,
    `      <Name>${xmlEscape(f.name)}</Name>`,
    `      <DataField>${xmlEscape(f.name)}</DataField>`,
    `      <DataSource>${xmlEscape(dsName)}</DataSource>`,
    `    </AxDataEntityViewField>`,
  ].join('\n'));
  if (keys.saveDataPerCompany) {
    fieldXml.push([
      `    <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">`,
      `      <Name>dataAreaId</Name>`,
      `      <DataField>DataAreaId</DataField>`,
      `      <DataSource>${xmlEscape(dsName)}</DataSource>`,
      `    </AxDataEntityViewField>`,
    ].join('\n'));
  }
  const keyXml = keyFieldNames
    .map((k) => `        <AxDataEntityViewKeyField>\n          <DataField>${xmlEscape(k)}</DataField>\n        </AxDataEntityViewKeyField>`)
    .join('\n');

  const entityXml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    ...warnings.map((w) => `<!-- WARNING: ${xmlCommentSafe(w)} -->`),
    ...notes.map((n) => `<!-- NOTE: ${xmlCommentSafe(n)} -->`),
    `<AxDataEntityView ${XMLNS}>`,
    `  <Name>${xmlEscape(spec.entityName)}</Name>`,
    spec.label ? `  <Label>${xmlEscape(spec.label)}</Label>` : '',
    `  <DataManagementEnabled>No</DataManagementEnabled>`,
    `  <EntityCategory>${xmlEscape(spec.entityCategory ?? 'Master')}</EntityCategory>`,
    `  <IsPublic>Yes</IsPublic>`,
    readOnly ? `  <IsReadOnly>Yes</IsReadOnly>` : '',
    keys.saveDataPerCompany ? `  <PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>` : '',
    `  <PrimaryKey>EntityKey</PrimaryKey>`,
    `  <PublicCollectionName>${xmlEscape(publicCollectionName)}</PublicCollectionName>`,
    `  <PublicEntityName>${xmlEscape(publicEntityName)}</PublicEntityName>`,
    `  <Fields>`,
    fieldXml.join('\n'),
    `  </Fields>`,
    `  <Keys>`,
    `    <AxDataEntityViewKey>`,
    `      <Name>EntityKey</Name>`,
    `      <Fields>`,
    keyXml,
    `      </Fields>`,
    `    </AxDataEntityViewKey>`,
    `  </Keys>`,
    `  <Mappings />`,
    `  <Ranges />`,
    `  <Relations />`,
    `  <StateMachines />`,
    `  <ViewMetadata>`,
    `    <Name>Metadata</Name>`,
    `    <SourceCode>`,
    `      <Methods />`,
    `    </SourceCode>`,
    `    <DataSources>`,
    `      <AxQuerySimpleRootDataSource>`,
    `        <Name>${xmlEscape(dsName)}</Name>`,
    `        <DynamicFields>Yes</DynamicFields>`,
    `        <Table>${xmlEscape(table.name)}</Table>`,
    `        <DataSources />`,
    `        <DerivedDataSources />`,
    `        <Fields />`,
    `        <Ranges />`,
    `        <GroupBy />`,
    `        <Having />`,
    `        <OrderBy />`,
    `      </AxQuerySimpleRootDataSource>`,
    `    </DataSources>`,
    `  </ViewMetadata>`,
    `</AxDataEntityView>`,
  ].filter((line) => line !== '').join('\n');

  return withGeneratedFiles(ok(entityXml), [{ aotType: 'AxDataEntityView', name: spec.entityName, content: `${entityXml}\n` }]);
}

// ---------------------------------------------------------------------------
// Security generators
// ---------------------------------------------------------------------------

export interface PrivilegeTarget {
  type: SecurableType;
  name: string;
  access?: 'view' | 'maintain';
  grants?: GrantLevel[];
}

function presetGrants(type: SecurableType, access: 'view' | 'maintain'): GrantLevel[] {
  if (type === 'MenuItemAction') return ['Invoke'];
  if (access === 'view' || type === 'MenuItemOutput') return ['Read'];
  return ['Read', 'Update', 'Create', 'Delete'];
}

function grantXml(levels: GrantLevel[], indent: string): string {
  const ordered = GRANT_ORDER.filter((g) => levels.includes(g));
  return [`${indent}<Grant>`, ...ordered.map((g) => `${indent}  <${g}>Allow</${g}>`), `${indent}</Grant>`].join('\n');
}

interface ResolvedTarget {
  type: SecurableType;
  name: string;
  grants: GrantLevel[];
  isPublic?: boolean;
}

function validateNewSecurityName(db: Database, name: string, type: 'SecurityPrivilege' | 'SecurityDuty' | 'SecurityRole', errors: string[]) {
  const naming = validateNaming(name);
  if (!naming.ok) errors.push(`Invalid ${type} name: ${naming.error}`);
  else if (getObject(db, name, type)) errors.push(`A ${type} named '${name}' already exists in the index.`);
}

function resolveTargets(db: Database, targets: PrivilegeTarget[], errors: string[]): ResolvedTarget[] {
  const seen = new Set<string>();
  const resolved: ResolvedTarget[] = [];
  for (const t of targets) {
    const obj = getObject(db, t.name, t.type);
    if (!obj) {
      errors.push(`${t.type} '${t.name}' was not found in the index.`);
      continue;
    }
    const key = `${t.type}:${obj.name}`.toLowerCase();
    if (seen.has(key)) {
      errors.push(`${t.type} '${obj.name}' is listed more than once.`);
      continue;
    }
    seen.add(key);
    const grants = t.grants && t.grants.length > 0 ? t.grants : presetGrants(t.type, t.access ?? 'view');
    if (t.type === 'DataEntity' && grants.includes('Invoke')) errors.push(`DataEntity '${obj.name}': Invoke is not a data entity grant.`);
    if (t.type === 'MenuItemAction' && grants.some((g) => g !== 'Invoke' && g !== 'Read')) {
      errors.push(`MenuItemAction '${obj.name}': action menu items take Invoke (or Read), not ${grants.join('/')}.`);
    }
    resolved.push({
      type: t.type,
      name: obj.name,
      grants,
      isPublic: t.type === 'DataEntity' ? obj.properties.isPublic === 'true' : undefined,
    });
  }
  return resolved;
}

function privilegeXml(name: string, label: string | undefined, targets: ResolvedTarget[], comments: string[] = []): string {
  const entities = targets.filter((t) => t.type === 'DataEntity');
  const entryPoints = targets.filter((t) => t.type !== 'DataEntity');
  const entityXml = entities.map((t) => [
    `    <AxSecurityDataEntityPermission>`,
    grantXml(t.grants, '      '),
    `      <Name>${xmlEscape(t.name)}</Name>`,
    `    </AxSecurityDataEntityPermission>`,
  ].join('\n'));
  const entryXml = entryPoints.map((t) => [
    `    <AxSecurityEntryPointReference>`,
    `      <Name>${xmlEscape(t.name)}</Name>`,
    grantXml(t.grants, '      '),
    `      <ObjectName>${xmlEscape(t.name)}</ObjectName>`,
    `      <ObjectType>${t.type}</ObjectType>`,
    `    </AxSecurityEntryPointReference>`,
  ].join('\n'));
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    ...comments.map((c) => `<!-- ${xmlCommentSafe(c)} -->`),
    `<AxSecurityPrivilege ${XMLNS}>`,
    `  <Name>${xmlEscape(name)}</Name>`,
    label ? `  <Label>${xmlEscape(label)}</Label>` : '',
    entityXml.length ? `  <DataEntityPermissions>\n${entityXml.join('\n')}\n  </DataEntityPermissions>` : `  <DataEntityPermissions />`,
    `  <DirectAccessPermissions />`,
    entryXml.length ? `  <EntryPoints>\n${entryXml.join('\n')}\n  </EntryPoints>` : `  <EntryPoints />`,
    `  <FormControlOverrides />`,
    `</AxSecurityPrivilege>`,
  ].filter((l) => l !== '').join('\n');
}

function checkLabel(db: Database, label: string | undefined, errors: string[]) {
  if (label && label.startsWith('@') && !resolveLabel(db, label)) errors.push(`Label '${label}' was not found in the label index.`);
}

export function generateSecurityPrivilegeXml(
  db: Database,
  spec: { name: string; label?: string; targets: PrivilegeTarget[] }
): ToolResult {
  const errors: string[] = [];
  validateNewSecurityName(db, spec.name, 'SecurityPrivilege', errors);
  checkLabel(db, spec.label, errors);
  if (spec.targets.length === 0) errors.push('At least one target is required.');
  const targets = resolveTargets(db, spec.targets, errors);
  if (errors.length > 0) return fail(['Grounding failed:', ...errors]);

  const comments = [
    'Add this privilege to a duty, and the duty to a role, or BPErrorDutyNotCoveredByRole / unreachable access follows.',
    ...targets.filter((t) => t.isPublic === false).map((t) => `WARNING: DataEntity ${t.name} is not public; OData callers cannot reach it.`),
  ];
  return withFileBlocks(ok(fileBlock(`AxSecurityPrivilege/${spec.name}.xml`, privilegeXml(spec.name, spec.label, targets, comments))));
}

export function generateReadOnlyRoleXml(
  db: Database,
  spec: { roleName: string; entities: string[]; label?: string; description?: string; privilegeName?: string; dutyName?: string }
): ToolResult {
  const errors: string[] = [];
  const privilegeName = spec.privilegeName || `${spec.roleName}View`;
  const dutyName = spec.dutyName || `${spec.roleName}Inquire`;
  validateNewSecurityName(db, spec.roleName, 'SecurityRole', errors);
  validateNewSecurityName(db, dutyName, 'SecurityDuty', errors);
  validateNewSecurityName(db, privilegeName, 'SecurityPrivilege', errors);
  if (new Set([spec.roleName, dutyName, privilegeName].map((n) => n.toLowerCase())).size < 3) {
    errors.push('Role, duty and privilege names must differ.');
  }
  checkLabel(db, spec.label, errors);
  if (spec.entities.length === 0) errors.push('At least one data entity is required.');
  const targets = resolveTargets(
    db,
    spec.entities.map((name) => ({ type: 'DataEntity' as const, name, grants: ['Read' as const] })),
    errors
  );
  if (errors.length > 0) return fail(['Grounding failed:', ...errors]);

  const warnings = targets
    .filter((t) => t.isPublic === false)
    .map((t) => `WARNING: DataEntity ${t.name} is not public; OData callers cannot reach it.`);
  const label = spec.label ? `  <Label>${xmlEscape(spec.label)}</Label>` : '';

  const duty = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<AxSecurityDuty ${XMLNS}>`,
    `  <Name>${xmlEscape(dutyName)}</Name>`,
    label,
    `  <Privileges>`,
    `    <AxSecurityPrivilegeReference>`,
    `      <Name>${xmlEscape(privilegeName)}</Name>`,
    `    </AxSecurityPrivilegeReference>`,
    `  </Privileges>`,
    `</AxSecurityDuty>`,
  ].filter((l) => l !== '').join('\n');

  const role = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<AxSecurityRole ${XMLNS}>`,
    `  <Name>${xmlEscape(spec.roleName)}</Name>`,
    label,
    spec.description ? `  <Description>${xmlEscape(spec.description)}</Description>` : '',
    `  <DirectAccessPermissions />`,
    `  <Duties>`,
    `    <AxSecurityDutyReference>`,
    `      <Name>${xmlEscape(dutyName)}</Name>`,
    `    </AxSecurityDutyReference>`,
    `  </Duties>`,
    `  <FormControlOverrides />`,
    `  <Privileges />`,
    `  <SubRoles />`,
    `</AxSecurityRole>`,
  ].filter((l) => l !== '').join('\n');

  return withFileBlocks(ok([
    fileBlock(`AxSecurityPrivilege/${privilegeName}.xml`, privilegeXml(privilegeName, spec.label, targets, ['Read-only access; grants Read on each entity.', ...warnings])),
    fileBlock(`AxSecurityDuty/${dutyName}.xml`, duty),
    fileBlock(`AxSecurityRole/${spec.roleName}.xml`, role),
  ].join('\n\n')));
}

// ---------------------------------------------------------------------------
// create_odata_action
// ---------------------------------------------------------------------------

const XPP_PRIMITIVES = new Set(['str', 'int', 'int64', 'real', 'boolean', 'date', 'utcdatetime', 'guid']);

export interface ODataActionSpec {
  entityName: string;
  actionName: string;
  instance: boolean;
  parameters?: { name: string; type: string }[];
  returnType?: string;
  extensionName?: string;
  description?: string;
}

function resolveXppType(db: Database, type: string): string | null {
  if (XPP_PRIMITIVES.has(type.toLowerCase())) return type.toLowerCase();
  for (const kind of ['Edt', 'Enum']) {
    const obj = getObject(db, type, kind);
    if (obj) return obj.name;
  }
  return null;
}

export function generateODataActionXpp(db: Database, spec: ODataActionSpec): ToolResult {
  const errors: string[] = [];
  const entity = getObject(db, spec.entityName, 'DataEntity');
  if (!entity) errors.push(`DataEntity '${spec.entityName}' was not found in the index.`);
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!identifier.test(spec.actionName)) errors.push(`Action name '${spec.actionName}' is not a valid X++ identifier.`);
  const extensionName = spec.extensionName ?? `${spec.entityName}_Extension`;
  const naming = validateNaming(extensionName);
  if (!naming.ok) errors.push(`Invalid extension name: ${naming.error}`);
  else if (getObject(db, extensionName, 'Class')) errors.push(`A Class named '${extensionName}' already exists; pass another extensionName or add the method to it.`);

  const seen = new Set<string>();
  const params = (spec.parameters ?? []).map((p) => {
    if (!identifier.test(p.name)) errors.push(`Parameter name '${p.name}' is not a valid X++ identifier.`);
    if (seen.has(p.name.toLowerCase())) errors.push(`Parameter '${p.name}' is declared twice.`);
    seen.add(p.name.toLowerCase());
    const type = resolveXppType(db, p.type);
    if (!type) errors.push(`Parameter '${p.name}': type '${p.type}' is not an X++ primitive or an indexed EDT/enum.`);
    return { name: p.name, type: type ?? p.type };
  });
  let returnType = 'void';
  if (spec.returnType && spec.returnType.toLowerCase() !== 'void') {
    const resolved = resolveXppType(db, spec.returnType);
    if (!resolved) errors.push(`Return type '${spec.returnType}' is not an X++ primitive or an indexed EDT/enum.`);
    returnType = resolved ?? spec.returnType;
  }
  if (errors.length || !entity) return fail(['Grounding failed:', ...errors]);

  const collection = entity.properties.publicCollectionName ?? '';
  const isPublic = entity.properties.isPublic === 'true';
  const route = collection
    ? `POST /data/${collection}${spec.instance ? '(<key>)' : ''}/Microsoft.Dynamics.DataEntities.${spec.actionName}`
    : 'Entity has no PublicCollectionName; set one before calling the action through OData.';
  const body = params.length ? `{ ${params.map((p) => `"${p.name}": ...`).join(', ')} }` : '(no body)';
  const signature = params.map((p) => `${p.type} _${p.name}`).join(', ');
  const header = [
    '// Generated by D365 FnO MCP Server',
    `// Target: DataEntity ${entity.name} (package ${entity.package})`,
    `// OData: ${route}`,
    `// Request body: ${body}`,
    spec.instance ? '// Instance action: `this` is the entity record addressed by the key in the URL.' : '// Static action: bound to the entity set, not to a record.',
    '// Callers need a privilege that grants the entity (see create_security_privilege).',
    ...(isPublic ? [] : ['// WARNING: the entity is not public; OData cannot reach the action until IsPublic = Yes.']),
  ];
  return okClass({
    name: extensionName,
    declaration: [...header, `[ExtensionOf(tableStr(${entity.name}))]`, `final class ${extensionName}`],
    methods: [{
      name: spec.actionName,
      lines: [
        '    /// <summary>',
        `    /// ${spec.description ?? `OData action ${spec.actionName}.`}`,
        '    /// </summary>',
        `    [SysODataActionAttribute('${spec.actionName}', ${spec.instance ? 'true' : 'false'})]`,
        `    public ${spec.instance ? '' : 'static '}${returnType} ${spec.actionName}(${signature})`,
        '    {',
        ...(returnType === 'void' ? ['        // TODO: implement'] : [`        ${returnType} result;`, '', '        // TODO: implement', '', '        return result;']),
        '    }',
      ],
    }],
  });
}

export function registerEntityTools(server: McpServer, db: Database) {
  server.tool(
    'check_entity_odata_readiness',
    'Check whether a data entity can be called through OData (/data) by integrations, Power Platform or AI agents: public names, keys, read-only flag, unsupported field types, backing tables and which privileges/roles grant it',
    { entityName: z.string() },
    READ_ONLY_TOOL,
    async ({ entityName }) => checkEntityODataReadiness(db, entityName)
  );

  server.tool(
    'create_data_entity',
    'Generate AxDataEntityView XML for a table (grounded: fields, natural key from the table indexes, unique OData names). Read-only by default, suited to exposing data to AI agents. Preview only; nothing is written',
    {
      table: z.string(),
      entityName: z.string(),
      fields: z.array(z.string()).max(1000).optional().describe('Table fields to map. Default: all non-container fields, including inherited ones.'),
      keyFields: z.array(z.string()).max(50).optional().describe('Entity key. Default: the table replacement key, alternate key, or first unique index.'),
      publicEntityName: z.string().optional(),
      publicCollectionName: z.string().optional(),
      readOnly: z.boolean().default(true),
      entityCategory: z.enum(['Master', 'Reference', 'Document', 'Transaction', 'Parameter']).default('Master'),
      label: z.string().optional(),
    },
    READ_ONLY_TOOL,
    async (args) => generateDataEntityXml(db, args)
  );

  server.tool(
    'create_security_privilege',
    'Generate AxSecurityPrivilege XML granting menu items and/or data entities (grounded: targets must exist, name must be new). access=view grants Read (Invoke for action menu items); maintain grants Read/Update/Create/Delete. Preview only',
    {
      name: z.string(),
      label: z.string().optional(),
      targets: z.array(
        z.object({
          type: z.enum(SECURABLE_TYPES),
          name: z.string(),
          access: z.enum(['view', 'maintain']).default('view'),
          grants: z.array(z.enum(GRANT_ORDER)).optional().describe('Explicit grant levels; overrides access.'),
        })
      ).min(1).max(500),
    },
    READ_ONLY_TOOL,
    async (args) => generateSecurityPrivilegeXml(db, args)
  );

  server.tool(
    'create_readonly_role_for_entities',
    'Generate a privilege (Read on each entity), a duty and a role that give read-only access to a list of data entities, e.g. for an AI agent or reporting service account. Preview only',
    {
      roleName: z.string(),
      entities: z.array(z.string()).min(1).max(500),
      label: z.string().optional(),
      description: z.string().optional(),
      privilegeName: z.string().optional().describe('Default: <roleName>View'),
      dutyName: z.string().optional().describe('Default: <roleName>Inquire'),
    },
    READ_ONLY_TOOL,
    async (args) => generateReadOnlyRoleXml(db, args)
  );

  server.tool(
    'create_odata_action',
    'Generate an X++ extension of a data entity with a [SysODataActionAttribute] method, so integrations and AI agents can call business logic through OData (grounded: entity, EDT/enum parameter types). Preview only',
    {
      entityName: z.string(),
      actionName: z.string(),
      instance: z.boolean().default(false).describe('true: bound to one record (this); false: static, bound to the entity set.'),
      parameters: z.array(z.object({ name: z.string(), type: z.string().describe('X++ primitive (str, int, int64, real, boolean, date, utcdatetime, guid) or an EDT/enum name') })).max(100).optional(),
      returnType: z.string().optional().describe('Default: void'),
      extensionName: z.string().optional().describe('Default: <entityName>_Extension'),
      description: z.string().optional(),
    },
    READ_ONLY_TOOL,
    async (args) => generateODataActionXpp(db, args)
  );
}
