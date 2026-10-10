import type { Database } from '../indexer/db.js';
import { getObjectHeader, getSecurityGrants, getXrefsFrom, getXrefsTo, type SecurityGrantRow } from '../indexer/db.js';

/**
 * Read-only traversal of the indexed security model:
 * Role -(role_duty)-> Duty -(duty_privilege)-> Privilege -(entrypoint|entity_permission)-> MenuItem/DataEntity
 * plus Role -(role_privilege)-> Privilege, Role -(subrole)-> Role and
 * Role/Duty extensions that contribute to their base object via `extends`.
 */

export const MENU_ITEM_TYPES = ['MenuItemDisplay', 'MenuItemAction', 'MenuItemOutput'] as const;

/** Keep unresolved references visible, but use indexed spelling for known objects. */
function indexedName(db: Database, name: string, type: string): string {
  return getObjectHeader(db, name, type)?.name ?? name;
}

/** `SystemUser.MyExtension` -> `SystemUser`: extension files are named after the object they extend. */
export function extensionBaseName(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The role or duty an xref source contributes to: extensions resolve to their base object. */
function owningName(fromType: string, fromName: string): string {
  return fromType.endsWith('Extension') ? extensionBaseName(fromName) : fromName;
}

function extensionsOf(db: Database, name: string, baseType: 'SecurityRole' | 'SecurityDuty'): string[] {
  return getXrefsTo(db, name, baseType, undefined, 'extends')
    .filter((x) => x.from_type === `${baseType}Extension`)
    .map((x) => x.from_name)
    .sort();
}

/** Sources that define a role/duty's content: the object itself plus all of its extensions. */
function definitionSources(db: Database, name: string, baseType: 'SecurityRole' | 'SecurityDuty') {
  name = indexedName(db, name, baseType);
  return [
    { type: baseType as string, name },
    ...extensionsOf(db, name, baseType).map((ext) => ({ type: `${baseType}Extension`, name: ext })),
  ];
}

function targets(db: Database, sources: { type: string; name: string }[], kind: string): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    for (const x of getXrefsFrom(db, s.name, s.type, kind)) out.add(indexedName(db, x.to_name, x.to_type));
  }
  return [...out].sort();
}

export interface RoleDefinition {
  name: string;
  extensions: string[];
  duties: string[];
  privileges: string[];
  subRoles: string[];
}

/** A role's direct content including what its extensions add. */
export function getRoleDefinition(db: Database, role: string): RoleDefinition {
  const sources = definitionSources(db, role, 'SecurityRole');
  return {
    name: sources[0].name,
    extensions: sources.slice(1).map((s) => s.name),
    duties: targets(db, sources, 'role_duty'),
    privileges: targets(db, sources, 'role_privilege'),
    subRoles: targets(db, sources, 'subrole'),
  };
}

/** A duty's privileges including what its extensions add. */
export function getDutyPrivileges(db: Database, duty: string): { extensions: string[]; privileges: string[] } {
  const sources = definitionSources(db, duty, 'SecurityDuty');
  return { extensions: sources.slice(1).map((s) => s.name), privileges: targets(db, sources, 'duty_privilege') };
}

export interface EffectiveRole {
  role: string;
  /** Roles included through sub-role nesting (excluding the role itself). */
  subRoles: string[];
  duties: string[];
  /** Privilege name -> how it is granted ("duty:X", or "role:Y" for a direct grant). */
  privileges: Map<string, string[]>;
  /** Roles/duties referenced but not present in the index. */
  missing: string[];
}

/**
 * Flattens a role through sub-roles, duties and extensions. Cycle-safe: each
 * role is expanded once. `cache` can be shared across calls for batch analysis.
 */
export function expandRole(db: Database, role: string, cache: Map<string, EffectiveRole> = new Map()): EffectiveRole {
  role = indexedName(db, role, 'SecurityRole');
  const cached = cache.get(role);
  if (cached) return cached;

  const duties = new Set<string>();
  const privileges = new Map<string, string[]>();
  const missing = new Set<string>();
  const visitedRoles = new Set<string>();
  const dutyPrivileges = new Map<string, string[]>();

  const addPrivilege = (priv: string, via: string) => {
    const list = privileges.get(priv);
    if (!list) privileges.set(priv, [via]);
    else if (!list.includes(via)) list.push(via);
  };

  const queue = [role];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visitedRoles.has(current)) continue;
    visitedRoles.add(current);
    if (current !== role && !getObjectHeader(db, current, 'SecurityRole')) missing.add(`SecurityRole:${current}`);

    const def = getRoleDefinition(db, current);
    for (const priv of def.privileges) addPrivilege(priv, `role:${current}`);
    for (const duty of def.duties) {
      duties.add(duty);
      let privs = dutyPrivileges.get(duty);
      if (!privs) {
        privs = getDutyPrivileges(db, duty).privileges;
        dutyPrivileges.set(duty, privs);
        if (!getObjectHeader(db, duty, 'SecurityDuty')) missing.add(`SecurityDuty:${duty}`);
      }
      for (const priv of privs) addPrivilege(priv, `duty:${duty}`);
    }
    for (const sub of def.subRoles) if (!visitedRoles.has(sub)) queue.push(sub);
  }

  visitedRoles.delete(role);
  const result: EffectiveRole = {
    role,
    subRoles: [...visitedRoles].sort(),
    duties: [...duties].sort(),
    privileges: new Map([...privileges.entries()].sort(([a], [b]) => a.localeCompare(b))),
    missing: [...missing].sort(),
  };
  cache.set(role, result);
  return result;
}

function sourcesReferencing(db: Database, name: string, type: string, kind: string): string[] {
  const out = new Set<string>();
  for (const x of getXrefsTo(db, name, type, undefined, kind)) {
    out.add(indexedName(db, owningName(x.from_type, x.from_name), x.from_type.replace(/Extension$/, '')));
  }
  return [...out].sort();
}

/** Duties that contain a privilege (extensions resolved to their base duty). */
export function dutiesContainingPrivilege(db: Database, privilege: string): string[] {
  return sourcesReferencing(db, privilege, 'SecurityPrivilege', 'duty_privilege');
}

/** Roles that directly contain a duty (extensions resolved to their base role). */
export function rolesContainingDuty(db: Database, duty: string): string[] {
  return sourcesReferencing(db, duty, 'SecurityDuty', 'role_duty');
}

/** Roles that grant a privilege directly, without a duty. */
export function rolesContainingPrivilegeDirectly(db: Database, privilege: string): string[] {
  return sourcesReferencing(db, privilege, 'SecurityPrivilege', 'role_privilege');
}

/** Roles that include `role` as a sub-role, transitively. Cycle-safe. */
export function parentRoles(db: Database, role: string): string[] {
  role = indexedName(db, role, 'SecurityRole');
  const out = new Set<string>();
  const queue = [role];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of sourcesReferencing(db, current, 'SecurityRole', 'subrole')) {
      if (parent !== role && !out.has(parent)) {
        out.add(parent);
        queue.push(parent);
      }
    }
  }
  return [...out].sort();
}

export function getPrivilegeGrants(db: Database, privilege: string): SecurityGrantRow[] {
  return getSecurityGrants(db, privilege);
}

export interface EntryPointTarget {
  type: string;
  name: string;
  /** The object a menu item opens, when the entry point was resolved from that object. */
  target?: { type: string; name: string };
}

/**
 * Entry points that expose an object. Menu items and data entities are entry
 * points themselves; forms, classes and reports are reached through the menu
 * items that target them.
 */
export function resolveEntryPoints(db: Database, objectType: string, objectName: string): EntryPointTarget[] {
  objectName = indexedName(db, objectName, objectType);
  if ((MENU_ITEM_TYPES as readonly string[]).includes(objectType) || objectType === 'DataEntity') {
    return [{ type: objectType, name: objectName }];
  }
  return getXrefsTo(db, objectName, objectType, undefined, 'menuitem_target')
    .map((x) => ({ type: x.from_type, name: x.from_name, target: { type: objectType, name: objectName } }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SecurityPath {
  entryPoint: { type: string; name: string };
  privilege: string;
  grants: string;
  /** Null when the privilege is granted directly to the role. */
  duty: string | null;
  role: string;
  /** Set when `role` gets access only because it nests this sub-role. */
  viaSubRole?: string;
}

/** Every Role -> (Duty) -> Privilege path that grants access to an entry point. */
export function findSecurityPaths(db: Database, entryPoint: EntryPointTarget): SecurityPath[] {
  const kind = entryPoint.type === 'DataEntity' ? 'entity_permission' : 'entrypoint';
  const privileges = new Set(getXrefsTo(db, entryPoint.name, entryPoint.type, undefined, kind).map((x) => x.from_name));
  const paths: SecurityPath[] = [];

  for (const privilege of [...privileges].sort()) {
    const grantRow = getSecurityGrants(db, privilege).find(
      (g) => g.target_name.toLowerCase() === entryPoint.name.toLowerCase() && g.target_type === entryPoint.type
    );
    const base = {
      entryPoint: { type: entryPoint.type, name: entryPoint.name },
      privilege,
      grants: grantRow?.grants ?? '',
    };

    const direct: { duty: string | null; role: string }[] = [];
    for (const duty of dutiesContainingPrivilege(db, privilege)) {
      for (const role of rolesContainingDuty(db, duty)) direct.push({ duty, role });
    }
    for (const role of rolesContainingPrivilegeDirectly(db, privilege)) direct.push({ duty: null, role });

    for (const d of direct) {
      paths.push({ ...base, ...d });
      for (const parent of parentRoles(db, d.role)) paths.push({ ...base, duty: d.duty, role: parent, viaSubRole: d.role });
    }
  }
  return paths;
}

export interface SodRule {
  name: string;
  dutyA: string;
  dutyB: string;
}

export interface SodConflict {
  rule: string;
  role: string;
  dutyA: string;
  dutyB: string;
}

/** Roles whose effective duties include both duties of a segregation-of-duties rule. */
export function analyzeSodConflicts(db: Database, rules: SodRule[], roles: string[]): SodConflict[] {
  const cache = new Map<string, EffectiveRole>();
  const conflicts: SodConflict[] = [];
  for (const role of roles) {
    const effective = expandRole(db, role, cache);
    const duties = new Map(effective.duties.map((duty) => [duty.toLowerCase(), duty]));
    for (const rule of rules) {
      const dutyA = duties.get(rule.dutyA.toLowerCase());
      const dutyB = duties.get(rule.dutyB.toLowerCase());
      if (dutyA && dutyB) {
        conflicts.push({ rule: rule.name, role: effective.role, dutyA, dutyB });
      }
    }
  }
  return conflicts;
}

export function listRoleNames(db: Database): string[] {
  return (
    db.prepare(`SELECT name FROM ax_objects WHERE type = 'SecurityRole' ORDER BY name`).all() as { name: string }[]
  ).map((r) => r.name);
}
