import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { getObjectByName } from '../indexer/db.js';
import {
  analyzeSodConflicts,
  dutiesContainingPrivilege,
  expandRole,
  findSecurityPaths,
  getDutyPrivileges,
  getPrivilegeGrants,
  getRoleDefinition,
  listRoleNames,
  parentRoles,
  resolveEntryPoints,
  rolesContainingDuty,
  rolesContainingPrivilegeDirectly,
} from '../security/model.js';
import { READ_ONLY_TOOL } from './annotations.js';
import { withGeneratedFiles } from './generatedFiles.js';
import {
  convertSecurityExport, SECURITY_CONVERTER_ATTRIBUTION, SECURITY_KIND_TO_AOT,
} from '../security/converter.js';

export const SECURITY_TYPE_TO_AOT = { Role: 'SecurityRole', Duty: 'SecurityDuty', Privilege: 'SecurityPrivilege' } as const;

/** Keeps responses bounded: returns the first `max` items with the true total. */
function capped<T>(items: T[], max: number): { total: number; truncated: boolean; items: T[] } {
  return { total: items.length, truncated: items.length > max, items: items.slice(0, max) };
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function error(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function objectSummary(db: Database, type: string, name: string) {
  const obj = getObjectByName(db, name, type);
  if (!obj) return null;
  return {
    name: obj.name,
    type,
    label: obj.properties?.label ?? '',
    description: obj.properties?.description ?? '',
    package: obj.package,
    model: obj.model,
  };
}

export function registerSecurityTools(server: McpServer, db: Database) {
  server.tool(
    'get_security_object',
    'Describe an indexed security role, duty or privilege: its direct content (including role/duty extensions), where it is used, and for privileges the entry points and data entities it grants. flatten=true expands a role through sub-roles and duties into its effective privileges.',
    {
      type: z.enum(['Role', 'Duty', 'Privilege']),
      name: z.string(),
      flatten: z.boolean().default(false),
      maxItems: z.number().int().min(1).max(1000).default(100),
    },
    READ_ONLY_TOOL,
    async ({ type, name, flatten, maxItems }) => {
      const aotType = SECURITY_TYPE_TO_AOT[type];
      const summary = objectSummary(db, aotType, name);
      name = summary?.name ?? name;

      if (type === 'Role') {
        const def = getRoleDefinition(db, name);
        if (!summary && def.extensions.length === 0) {
          return error(`Security role ${name} not found in the index. Use search_symbols with type SecurityRole.`);
        }
        const result: Record<string, unknown> = {
          ...(summary ?? { name, type: aotType, note: 'Base role is not indexed; only its extensions were found.' }),
          extensions: def.extensions,
          duties: capped(def.duties, maxItems),
          privileges: capped(def.privileges, maxItems),
          subRoles: def.subRoles,
          includedInRoles: parentRoles(db, name),
        };
        if (flatten) {
          const effective = expandRole(db, name);
          result.effective = {
            subRoles: effective.subRoles,
            duties: capped(effective.duties, maxItems),
            privileges: capped(
              [...effective.privileges.entries()].map(([privilege, via]) => ({ privilege, via })),
              maxItems
            ),
            missingFromIndex: effective.missing,
          };
        }
        return json(result);
      }

      if (type === 'Duty') {
        const duty = getDutyPrivileges(db, name);
        if (!summary && duty.extensions.length === 0) {
          return error(`Security duty ${name} not found in the index. Use search_symbols with type SecurityDuty.`);
        }
        return json({
          ...(summary ?? { name, type: aotType, note: 'Base duty is not indexed; only its extensions were found.' }),
          extensions: duty.extensions,
          privileges: capped(duty.privileges, maxItems),
          usedByRoles: capped(rolesContainingDuty(db, name), maxItems),
        });
      }

      if (!summary) {
        return error(`Security privilege ${name} not found in the index. Use search_symbols with type SecurityPrivilege.`);
      }
      const grants = getPrivilegeGrants(db, name).map((g) => ({
        kind: g.kind,
        objectType: g.target_type,
        objectName: g.target_name,
        ...(g.child_name ? { childName: g.child_name } : {}),
        grants: g.grants ? g.grants.split(',') : [],
      }));
      return json({
        ...summary,
        entryPoints: capped(grants.filter((g) => g.kind === 'entrypoint'), maxItems),
        dataEntityPermissions: capped(grants.filter((g) => g.kind === 'dataentity'), maxItems),
        usedByDuties: capped(dutiesContainingPrivilege(db, name), maxItems),
        grantedDirectlyByRoles: capped(rolesContainingPrivilegeDirectly(db, name), maxItems),
      });
    }
  );

  server.tool(
    'find_security_path',
    'Answer "which roles give access to this?" for a form, class, report, menu item or data entity. Forms/classes/reports are resolved through the menu items that open them. Returns every Role -> Duty -> Privilege -> entry point path found in the index, including roles that inherit access via sub-roles.',
    {
      objectType: z.enum(['Form', 'Class', 'SSRSReport', 'MenuItemDisplay', 'MenuItemAction', 'MenuItemOutput', 'DataEntity']),
      objectName: z.string(),
      maxPaths: z.number().int().min(1).max(1000).default(100),
    },
    READ_ONLY_TOOL,
    async ({ objectType, objectName, maxPaths }) => {
      const entryPoints = resolveEntryPoints(db, objectType, objectName);
      if (entryPoints.length === 0) {
        return json({
          objectType,
          objectName,
          entryPoints: [],
          roles: [],
          paths: capped([], maxPaths),
          note: `No indexed menu item targets ${objectType} ${objectName}, so no security path exists in the index.`,
        });
      }
      const paths = entryPoints.flatMap((ep) => findSecurityPaths(db, ep));
      const roles = [...new Set(paths.map((p) => p.role))].sort();
      const result: Record<string, unknown> = {
        objectType,
        objectName,
        entryPoints: entryPoints.map((ep) => ({ type: ep.type, name: ep.name })),
        roles,
        paths: capped(paths, maxPaths),
      };
      if (paths.length === 0) {
        result.note = 'No indexed privilege grants these entry points. They are not reachable through any indexed role.';
      }
      return json(result);
    }
  );

  server.tool(
    'analyze_sod_conflicts',
    'Check indexed roles against segregation-of-duties rules (pairs of duties that must not be held together). Each role is flattened through sub-roles and extensions. Checks all indexed roles unless roles is given. Static analysis of the AOT only: it does not see user-role assignments in an environment.',
    {
      rules: z
        .array(z.object({ name: z.string(), dutyA: z.string(), dutyB: z.string() }))
        .min(1)
        .max(200),
      roles: z.array(z.string()).max(2000).optional(),
      maxConflicts: z.number().int().min(1).max(2000).default(200),
    },
    READ_ONLY_TOOL,
    async ({ rules, roles, maxConflicts }) => {
      const roleNames = roles && roles.length > 0 ? roles : listRoleNames(db);
      const unknownRoles = roleNames.filter(
        (r) => !getObjectByName(db, r, 'SecurityRole') && getRoleDefinition(db, r).extensions.length === 0
      );
      const unknownDuties = [...new Set(rules.flatMap((r) => [r.dutyA, r.dutyB]))].filter(
        (d) => !getObjectByName(db, d, 'SecurityDuty')
      );
      const conflicts = analyzeSodConflicts(db, rules, roleNames);
      return json({
        rolesChecked: roleNames.length,
        rulesChecked: rules.length,
        conflicts: capped(conflicts, maxConflicts),
        unknownRoles,
        unknownDuties,
      });
    }
  );

  server.tool(
    'diff_roles',
    'Compare two security roles after flattening sub-roles, duties and extensions: duties and privileges only in A, only in B, and shared.',
    {
      roleA: z.string(),
      roleB: z.string(),
      maxItems: z.number().int().min(1).max(1000).default(100),
    },
    READ_ONLY_TOOL,
    async ({ roleA, roleB, maxItems }) => {
      for (const role of [roleA, roleB]) {
        if (!getObjectByName(db, role, 'SecurityRole') && getRoleDefinition(db, role).extensions.length === 0) {
          return error(`Security role ${role} not found in the index. Use search_symbols with type SecurityRole.`);
        }
      }
      const a = expandRole(db, roleA);
      const b = expandRole(db, roleB);
      const split = (left: string[], right: string[]) => {
        const r = new Set(right);
        const l = new Set(left);
        return {
          onlyA: capped(left.filter((x) => !r.has(x)), maxItems),
          onlyB: capped(right.filter((x) => !l.has(x)), maxItems),
          shared: capped(left.filter((x) => r.has(x)), maxItems),
        };
      };
      return json({
        roleA,
        roleB,
        duties: split(a.duties, b.duties),
        privileges: split([...a.privileges.keys()], [...b.privileges.keys()]),
        missingFromIndex: [...new Set([...a.missing, ...b.missing])].sort(),
      });
    }
  );

  server.tool(
    'convert_security_customizations',
    'Convert a Security configuration export (XML with AxSecurityRole/AxSecurityDuty/AxSecurityPrivilege elements, from System administration > Security configuration) ' +
      'into one AOT XML file per element (AxSecurityRole/<Name>.xml, ...), optionally prefixing/renaming elements and updating references to them. ' +
      'Flags references that are neither in the export nor in the index. Returns file contents only; nothing is written. Approach from D365FOSecurityConverter (MIT).',
    {
      xml: z.string().min(1).max(2_000_000).describe('Contents of the exported security configuration XML file.'),
      prefix: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe('Prefix for every exported element name, e.g. Contoso.'),
      renames: z.record(z.string(), z.string()).optional().describe('Explicit old name -> new name map (wins over prefix).'),
      include: z.array(z.string()).max(200).optional().describe('Only these element names.'),
      includeDependencies: z.boolean().default(true).describe('With include: also convert exported elements they reference.'),
      maxFiles: z.number().int().min(1).max(200).default(50),
    },
    READ_ONLY_TOOL,
    async ({ xml, prefix, renames, include, includeDependencies, maxFiles }) => {
      let result;
      try {
        result = convertSecurityExport(xml, {
          prefix, renames, include, includeDependencies,
          existsInIndex: (ref) =>
            Boolean(getObjectByName(db, ref.name, SECURITY_KIND_TO_AOT[ref.kind])),
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
      if (result.files.length === 0 && !include?.length) {
        return error('No AxSecurityRole, AxSecurityDuty or AxSecurityPrivilege elements with a <Name> were found in the XML.');
      }
      const clashes = result.files
        .filter((f) => f.name !== f.originalName && getObjectByName(db, f.name, SECURITY_KIND_TO_AOT[f.kind]))
        .map((f) => `${f.kind} ${f.name}`);
      const files = capped(result.files, maxFiles);
      return withGeneratedFiles(json({
        summary: {
          roles: result.files.filter((f) => f.kind === 'Role').length,
          duties: result.files.filter((f) => f.kind === 'Duty').length,
          privileges: result.files.filter((f) => f.kind === 'Privilege').length,
        },
        renamed: result.renamed,
        unresolvedReferences: result.unresolvedReferences,
        nameClashesWithIndex: clashes,
        duplicatesInExport: result.duplicates,
        skipped: result.skipped,
        // File contents travel once, in the generated files item that follows.
        files: { total: files.total, truncated: files.truncated, items: files.items.map(({ path }) => ({ path })) },
        nextSteps: [
          'Save the generated files into AxSecurityRole|AxSecurityDuty|AxSecurityPrivilege of your model and add them to the Visual Studio project, then build.',
          'Unrenamed elements keep their names; clashes with existing AOT elements must be renamed before import.',
        ],
        attribution: SECURITY_CONVERTER_ATTRIBUTION,
      }), files.items.map((f) => ({ aotType: `AxSecurity${f.kind}`, name: f.name, content: f.content })));
    }
  );
}
