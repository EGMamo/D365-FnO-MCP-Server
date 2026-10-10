import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../indexer/db.js';
import { z } from 'zod';
import * as dbUtils from '../indexer/db.js';
import { getIndexStats } from '../indexer/buildIndex.js';
import { loadObjectXml, sourceFileReadsAllowed } from '../indexer/sourceFiles.js';
import { findUsageRefs, getUsageSnapshotStatus } from '../indexer/xrefUsage.js';
import { capLists, DEFAULT_MAX_ITEMS } from './bounds.js';
import { analyzeImpact, explainSearchHits } from './impact.js';

/** Every object type the indexer stores, for tools that accept any indexed type. */
export const INDEXED_OBJECT_TYPES = [
  'Table',
  'TableExtension',
  'View',
  'Map',
  'Service',
  'ServiceGroup',
  'Report',
  'Menu',
  'MenuExtension',
  'MenuItemDisplayExtension',
  'MenuItemActionExtension',
  'MenuItemOutputExtension',
  'WorkflowType',
  'WorkflowApproval',
  'WorkflowTask',
  'WorkflowAutomatedTask',
  'WorkflowCategory',
  'AggregateMeasurement',
  'AggregateDimension',
  'KPI',

  'FormExtension',
  'EdtExtension',
  'EnumExtension',
  'DataEntityExtension',
  'QueryExtension',
  'Class',
  'Enum',
  'Form',
  'Query',
  'DataEntity',
  'Edt',
  'SecurityRole',
  'SecurityRoleExtension',
  'SecurityDuty',
  'SecurityDutyExtension',
  'SecurityPrivilege',
  'MenuItemDisplay',
  'MenuItemAction',
  'MenuItemOutput',
] as const;
export interface MetadataToolOptions {
  /** False when the deployed index has no corresponding source tree on this host. */
  sourceFilesAvailable?: boolean;
}

export function registerMetadataTools(server: McpServer, db: Database, options: MetadataToolOptions = {}) {
  server.tool(
    'get_usage_snapshot_status',
    'Inspect compiler usage import provenance and completeness. Check this before interpreting empty find_usages results as no usages. Static references are not runtime execution counts.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(getUsageSnapshotStatus(db), null, 2) }] })
  );
  server.tool(
    'search_symbols',
    'Search indexed AOT metadata for an object name or term. Full-text prefix matching searches names, object types, and packages, prioritizes exact name matches, and falls back to substring name matching when full-text finds nothing. Use a type filter to narrow results; inspect matches with the matching get_* tool or get_element_xml.',
    {
      query: z
        .string()
        .trim()
        .min(1, 'Enter a name or search term.')
        .max(200, 'Search terms must be 200 characters or fewer.')
        .describe('A non-empty object name or search term, e.g. CustTable or SalesLine.'),
      type: z
        .enum(INDEXED_OBJECT_TYPES)
        .optional()
        .describe('Optional AOT object type filter, e.g. Table or Class.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum matching objects to return (1-100; default 20).'),
      explain: z
        .boolean()
        .default(false)
        .describe('When true, each result states why it matched (exact, prefix, substring or token) and why it ranks where it does.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ query, type, limit, explain }) => {
      const results = dbUtils.searchSymbols(db, query, type, limit);
      if (explain) {
        const explained = explainSearchHits(query, results as { name: string; type: string; package: string; id: number }[]).map(
          ({ hit, match, explanation }) => ({ ...hit, match, explanation })
        );
        return { content: [{ type: 'text', text: JSON.stringify(explained, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_table_schema',
    'Full table details. Each list is capped at maxItems (default 1000); clipped lists are reported under "truncated".',
    { tableName: z.string(), xrefLimit: z.number().int().min(1).max(500).default(100), maxItems: z.number().int().min(10).max(10_000).default(1000).describe('Maximum items returned per list (fields, methods, controls, ...); a clipped list is reported under "truncated".') },
    async ({ tableName, xrefLimit, maxItems = DEFAULT_MAX_ITEMS }) => {
      const obj = dbUtils.getObjectByName(db, tableName, 'Table');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Table', tableName, 'Table') }] };
      const xrefs = dbUtils.getXrefsTo(db, obj.name, 'Table', xrefLimit);
      return { content: [{ type: 'text', text: JSON.stringify(capLists({ ...obj, xrefs }, ['fields', 'methods', 'xrefs'], maxItems), null, 2) }] };
    }
  );

  server.tool(
    'get_class_hierarchy',
    'Class inheritance',
    { className: z.string(), childLimit: z.number().int().min(1).max(500).default(100) },
    async ({ className, childLimit }) => {
      const obj = dbUtils.getObjectByName(db, className, 'Class');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Class', className, 'Class') }] };
      const children = dbUtils.getXrefsTo(db, obj.name, 'Class', childLimit, 'extends');
      return { content: [{ type: 'text', text: JSON.stringify({ class: obj.name, children }, null, 2) }] };
    }
  );

  server.tool(
    'get_method_signature',
    'Method details',
    { className: z.string(), methodName: z.string() },
    async ({ className, methodName }) => {
      const obj = dbUtils.getObjectByName(db, className, 'Class');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Class', className, 'Class') }] };
      const method = obj.methods.find((m) => m.name === methodName) ??
        obj.methods.find((m) => m.name.toLowerCase() === methodName.toLowerCase());
      if (!method) return { content: [{ type: 'text', text: `Method ${methodName} not found in ${className}.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(method, null, 2) }] };
    }
  );

  server.tool(
    'find_references',
    'Find structural/declared relationships of an AOT object, not compiler call sites (capped at 500 total). Use find_usages for the imported compiler snapshot.',
    {
      name: z.string(),
      type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Edt']).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ name, type, limit }) => {
      let xrefs: dbUtils.Xref[] = [];
      if (type) {
        xrefs = dbUtils.getXrefsTo(db, name, type, limit);
      } else {
        const types = ['Table', 'Class', 'Enum', 'Form', 'Edt'] as const;
        for (const t of types) {
          if (xrefs.length >= limit) break;
          const remaining = limit - xrefs.length;
          xrefs = xrefs.concat(dbUtils.getXrefsTo(db, name, t, remaining));
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(xrefs.slice(0, limit), null, 2) }] };
    }
  );

  server.tool(
    'analyze_impact',
    'Impact analysis: everything that structurally depends on an AOT object, walked transitively (extensions, subclasses, data sources, EDT use, ...), grouped by depth with the relationship that links each dependent. Bounded by maxDepth and limit; truncated=true means more exist. Declared references only, not compiler call sites: use find_usages for those.',
    {
      name: z.string(),
      type: z.enum(INDEXED_OBJECT_TYPES),
      maxDepth: z.number().int().min(1).max(4).default(2).describe('How many dependency levels to follow (1-4; default 2).'),
      limit: z.number().int().min(1).max(500).default(200).describe('Maximum dependents to return (1-500; default 200).'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ name, type, maxDepth = 2, limit = 200 }) => {
      const result = analyzeImpact(db, name, type, maxDepth, limit);
      if (!result) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, `Object (${type})`, name, type) }] };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'find_usages',
    'Find compiler-derived usage/call-site references imported from DynamicsXrefDB. This is distinct from structural/declared references returned by find_references.',
    {
      name: z.string(),
      type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']).optional(),
      method: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ name, type, method, limit }) => {
      const usages = findUsageRefs(db, name, type, method, limit);
      return { content: [{ type: 'text', text: JSON.stringify(usages, null, 2) }] };
    }
  );

  server.tool(
    'get_enum_values',
    'Enum details. The values list is capped at maxItems (default 1000); a clipped list is reported under "truncated".',
    { enumName: z.string(), maxItems: z.number().int().min(10).max(10_000).default(1000).describe('Maximum items returned per list; a clipped list is reported under "truncated".') },
    async ({ enumName, maxItems = DEFAULT_MAX_ITEMS }) => {
      const obj = dbUtils.getObjectByName(db, enumName, 'Enum');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Enum', enumName, 'Enum') }] };
      const result = {
        name: obj.name,
        package: obj.package,
        label: obj.properties.label ?? '',
        isExtensible: obj.properties.isExtensible === 'true',
        values: obj.enumValues,
      };
      return { content: [{ type: 'text', text: JSON.stringify(capLists(result, ['values'], maxItems), null, 2) }] };
    }
  );

  server.tool(
    'get_edt_details',
    'Extended Data Type details',
    { edtName: z.string() },
    async ({ edtName }) => {
      const obj = dbUtils.getObjectByName(db, edtName, 'Edt');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Edt', edtName, 'Edt') }] };
      const result = {
        name: obj.name,
        package: obj.package,
        extends: obj.properties.extends ?? '',
        label: obj.properties.label ?? '',
        helpText: obj.properties.helpText ?? '',
        stringSize: Number(obj.properties.stringSize ?? 0),
        edtType: obj.properties.edtType ?? '',
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_form_datasources',
    'Form datasource and control info. Each list is capped at maxItems (default 1000); clipped lists are reported under "truncated".',
    { formName: z.string(), maxItems: z.number().int().min(10).max(10_000).default(1000).describe('Maximum items returned per list (fields, methods, controls, ...); a clipped list is reported under "truncated".') },
    async ({ formName, maxItems = DEFAULT_MAX_ITEMS }) => {
      const obj = dbUtils.getObjectByName(db, formName, 'Form');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Form', formName, 'Form') }] };
      const result = {
        name: obj.name,
        package: obj.package,
        pattern: obj.properties.pattern ?? '',
        caption: obj.properties.caption ?? '',
        dataSources: obj.dataSources,
        controls: obj.controls,
      };
      return { content: [{ type: 'text', text: JSON.stringify(capLists(result, ['dataSources', 'controls'], maxItems), null, 2) }] };
    }
  );

  server.tool(
    'get_query_datasources',
    'Query datasource info. The list is capped at maxItems (default 1000); a clipped list is reported under "truncated".',
    { queryName: z.string(), maxItems: z.number().int().min(10).max(10_000).default(1000).describe('Maximum items returned per list; a clipped list is reported under "truncated".') },
    async ({ queryName, maxItems = DEFAULT_MAX_ITEMS }) => {
      const obj = dbUtils.getObjectByName(db, queryName, 'Query');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'Query', queryName, 'Query') }] };
      const result = {
        name: obj.name,
        package: obj.package,
        title: obj.properties.title ?? '',
        dataSources: obj.dataSources,
      };
      return { content: [{ type: 'text', text: JSON.stringify(capLists(result, ['dataSources'], maxItems), null, 2) }] };
    }
  );

  server.tool(
    'get_data_entity_details',
    'Data entity fields and datasources. Each list is capped at maxItems (default 1000); clipped lists are reported under "truncated".',
    { entityName: z.string(), maxItems: z.number().int().min(10).max(10_000).default(1000).describe('Maximum items returned per list (fields, methods, controls, ...); a clipped list is reported under "truncated".') },
    async ({ entityName, maxItems = DEFAULT_MAX_ITEMS }) => {
      const obj = dbUtils.getObjectByName(db, entityName, 'DataEntity');
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, 'DataEntity', entityName, 'DataEntity') }] };
      const result = {
        name: obj.name,
        package: obj.package,
        publicEntityName: obj.properties.publicEntityName ?? '',
        publicCollectionName: obj.properties.publicCollectionName ?? '',
        stagingTable: obj.properties.stagingTable ?? '',
        primaryKey: obj.properties.primaryKey ?? '',
        isPublic: obj.properties.isPublic === 'true',
        fields: obj.fields,
        dataSources: obj.dataSources,
      };
      return { content: [{ type: 'text', text: JSON.stringify(capLists(result, ['fields', 'dataSources'], maxItems), null, 2) }] };
    }
  );

  server.tool(
    'get_element_xml',
    'Raw XML of any AOT object. Output is capped at maxChars (default 100000); a truncated result says so and reports the full length so you can raise the cap or narrow with a get_* tool.',
    {
      name: z.string(),
      type: z.enum(INDEXED_OBJECT_TYPES),
      maxChars: z.number().int().min(1000).max(2_000_000).default(100_000).describe('Maximum characters of XML to return.'),
    },
    async ({ name, type, maxChars = 100_000 }) => {
      const obj = dbUtils.getObjectByName(db, name, type);
      if (!obj) return { content: [{ type: 'text', text: dbUtils.notFoundMessage(db, `Object (${type})`, name, type) }] };
      const xml = await loadObjectXml(obj);
      if (xml) {
        if (xml.length <= maxChars) return { content: [{ type: 'text', text: xml }] };
        return {
          content: [
            {
              type: 'text',
              text: `${xml.slice(0, maxChars)}\n<!-- TRUNCATED: returned ${maxChars} of ${xml.length} characters; call again with a larger maxChars (max 2000000) -->`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            // The path is only worth showing (and only safe to echo) for an index built on this machine.
            text: sourceFileReadsAllowed()
              ? `Raw XML for ${type} ${name} is not stored in the index and the source file could not be read at ${obj.file_path}.`
              : `Raw XML for ${type} ${name} is not stored in the index and its source file is not available on this server.`,
          },
        ],
      };
    }
  );

  server.tool(
    'list_objects',
    'List AOT objects',
    {
      type: z.enum(INDEXED_OBJECT_TYPES).optional(),
      package: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ type, package: pkg, offset, limit }) => {
      const results = dbUtils.getAllObjects(db, type, pkg, offset, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'list_packages',
    'List distinct packages present in the index',
    {},
    async () => {
      const results = dbUtils.listPackages(db);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'list_models',
    'List distinct models present in the index',
    {},
    async () => {
      const results = dbUtils.listModels(db);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_index_staleness',
    'List indexed objects whose source file changed on disk or no longer exists (examines up to 1000 rows). A server without source files reports the snapshot build time instead.',
    {
      limit: z.number().int().min(1).max(100).default(100),
      maxScan: z.number().int().min(1).max(5000).default(1000),
    },
    async ({ limit, maxScan }) => {
      if (options.sourceFilesAvailable === false) {
        const report = {
          mode: 'snapshot',
          builtAt: dbUtils.getMeta(db, dbUtils.META_KEYS.builtAt),
          message:
            'Source files are not present on this server, so per-file staleness cannot be checked.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      }
      const stale = await dbUtils.getIndexStaleness(db, limit, maxScan);
      return { content: [{ type: 'text', text: JSON.stringify(stale, null, 2) }] };
    }
  );

  server.tool(
    'get_index_stats',
    'Index status',
    {},
    async () => {
      const stats = getIndexStats(db);
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    }
  );
}
