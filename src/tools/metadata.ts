import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../indexer/db.js';
import { z } from 'zod';
import * as dbUtils from '../indexer/db.js';
import { getIndexStats } from '../indexer/buildIndex.js';
import fs from 'fs/promises';
import { findUsageRefs, getUsageSnapshotStatus } from '../indexer/xrefUsage.js';

/** Provenance of a published index served by a hosted (read-only) server. */
export interface PublishedIndexInfo {
  /** Manifest URL with any query string (SAS token) removed. */
  manifestUrl: string;
  syncedAt: string | null;
  builtAt: string | null;
  version: string | null;
}

export interface MetadataToolOptions {
  /** Set when the server serves a published index rather than a locally built one. */
  published?: PublishedIndexInfo;
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
    'Full-text search across all AOT objects',
    {
      query: z.string(),
      type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']).optional(),
      limit: z.number().int().min(1).max(100).default(20)
    },
    async ({ query, type, limit }) => {
      const results = dbUtils.searchSymbols(db, query, type, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_table_schema',
    'Full table details',
    { tableName: z.string(), xrefLimit: z.number().int().min(1).max(500).default(100) },
    async ({ tableName, xrefLimit }) => {
      const obj = dbUtils.getObjectByName(db, tableName, 'Table');
      if (!obj) return { content: [{ type: 'text', text: `Table ${tableName} not found.` }] };
      const xrefs = dbUtils.getXrefsTo(db, tableName, 'Table', xrefLimit);
      return { content: [{ type: 'text', text: JSON.stringify({ ...obj, xrefs }, null, 2) }] };
    }
  );

  server.tool(
    'get_class_hierarchy',
    'Class inheritance',
    { className: z.string(), childLimit: z.number().int().min(1).max(500).default(100) },
    async ({ className, childLimit }) => {
      const obj = dbUtils.getObjectByName(db, className, 'Class');
      if (!obj) return { content: [{ type: 'text', text: `Class ${className} not found.` }] };
      const children = dbUtils.getXrefsTo(db, className, 'Class', childLimit, 'extends');
      return { content: [{ type: 'text', text: JSON.stringify({ class: obj.name, children }, null, 2) }] };
    }
  );

  server.tool(
    'get_method_signature',
    'Method details',
    { className: z.string(), methodName: z.string() },
    async ({ className, methodName }) => {
      const obj = dbUtils.getObjectByName(db, className, 'Class');
      if (!obj) return { content: [{ type: 'text', text: `Class ${className} not found.` }] };
      const method = obj.methods.find((m: any) => m.name === methodName);
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
    'Enum details',
    { enumName: z.string() },
    async ({ enumName }) => {
      const obj = dbUtils.getObjectByName(db, enumName, 'Enum');
      if (!obj) return { content: [{ type: 'text', text: `Enum ${enumName} not found.` }] };
      const result = {
        name: obj.name,
        package: obj.package,
        label: obj.properties.label ?? '',
        isExtensible: obj.properties.isExtensible === 'true',
        values: obj.enumValues,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_edt_details',
    'Extended Data Type details',
    { edtName: z.string() },
    async ({ edtName }) => {
      const obj = dbUtils.getObjectByName(db, edtName, 'Edt');
      if (!obj) return { content: [{ type: 'text', text: `Edt ${edtName} not found.` }] };
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
    'Form datasource and control info',
    { formName: z.string() },
    async ({ formName }) => {
      const obj = dbUtils.getObjectByName(db, formName, 'Form');
      if (!obj) return { content: [{ type: 'text', text: `Form ${formName} not found.` }] };
      const result = {
        name: obj.name,
        package: obj.package,
        pattern: obj.properties.pattern ?? '',
        caption: obj.properties.caption ?? '',
        dataSources: obj.dataSources,
        controls: obj.controls,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_query_datasources',
    'Query datasource info',
    { queryName: z.string() },
    async ({ queryName }) => {
      const obj = dbUtils.getObjectByName(db, queryName, 'Query');
      if (!obj) return { content: [{ type: 'text', text: `Query ${queryName} not found.` }] };
      const result = {
        name: obj.name,
        package: obj.package,
        title: obj.properties.title ?? '',
        dataSources: obj.dataSources,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_data_entity_details',
    'Data entity fields and datasources',
    { entityName: z.string() },
    async ({ entityName }) => {
      const obj = dbUtils.getObjectByName(db, entityName, 'DataEntity');
      if (!obj) return { content: [{ type: 'text', text: `DataEntity ${entityName} not found.` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_element_xml',
    'Raw XML of any AOT object',
    { name: z.string(), type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']) },
    async ({ name, type }) => {
      const obj = dbUtils.getObjectByName(db, name, type);
      if (!obj) return { content: [{ type: 'text', text: `Object ${name} of type ${type} not found.` }] };
      if (obj.raw_xml) return { content: [{ type: 'text', text: obj.raw_xml }] };

      try {
        const xml = await fs.readFile(obj.file_path, 'utf-8');
        return { content: [{ type: 'text', text: xml }] };
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Raw XML for ${type} ${name} is not stored in the index and the source file could not be read at ${obj.file_path}.`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    'list_objects',
    'List AOT objects',
    {
      type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']).optional(),
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
    'List indexed objects whose source file changed on disk or no longer exists (examines up to 1000 rows). A server that serves a published index has no source files and reports the snapshot build time instead.',
    {
      limit: z.number().int().min(1).max(100).default(100),
      maxScan: z.number().int().min(1).max(5000).default(1000),
    },
    async ({ limit, maxScan }) => {
      if (options.published) {
        const report = {
          mode: 'published',
          ...options.published,
          message:
            'This server serves a published index snapshot; source files are not present, so per-file staleness cannot be checked. Compare builtAt with your local PackagesLocalDirectory.',
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
