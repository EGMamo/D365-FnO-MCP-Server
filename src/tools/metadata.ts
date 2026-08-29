import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Database } from 'better-sqlite3';
import { z } from 'zod';
import * as dbUtils from '../indexer/db.js';
import { getIndexStats } from '../indexer/buildIndex.js';

export function registerMetadataTools(server: McpServer, db: Database) {
  server.tool(
    'search_symbols',
    'Full-text search across all AOT objects',
    {
      query: z.string(),
      type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']).optional(),
      limit: z.number().max(100).default(20)
    },
    async ({ query, type, limit }) => {
      const results = dbUtils.searchSymbols(db, query, type, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_table_schema',
    'Full table details',
    { tableName: z.string() },
    async ({ tableName }) => {
      const obj = dbUtils.getObjectByName(db, tableName, 'Table');
      if (!obj) return { content: [{ type: 'text', text: `Table ${tableName} not found.` }] };
      const xrefs = dbUtils.getXrefsTo(db, tableName, 'Table');
      return { content: [{ type: 'text', text: JSON.stringify({ ...obj, xrefs }, null, 2) }] };
    }
  );

  server.tool(
    'get_class_hierarchy',
    'Class inheritance',
    { className: z.string() },
    async ({ className }) => {
      const obj = dbUtils.getObjectByName(db, className, 'Class');
      if (!obj) return { content: [{ type: 'text', text: `Class ${className} not found.` }] };
      const children = dbUtils.getXrefsTo(db, className, 'Class').filter((x: dbUtils.Xref) => x.xref_kind === 'extends');
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
    'Find all usages',
    { name: z.string(), type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Edt']).optional() },
    async ({ name, type }) => {
      let xrefs: dbUtils.Xref[] = [];
      if (type) {
        xrefs = dbUtils.getXrefsTo(db, name, type);
      } else {
        const types = ['Table', 'Class', 'Enum', 'Form', 'Edt'] as const;
        for (const t of types) {
          xrefs = xrefs.concat(dbUtils.getXrefsTo(db, name, t));
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(xrefs, null, 2) }] };
    }
  );

  server.tool(
    'get_enum_values',
    'Enum details',
    { enumName: z.string() },
    async ({ enumName }) => {
      const obj = dbUtils.getObjectByName(db, enumName, 'Enum');
      if (!obj) return { content: [{ type: 'text', text: `Enum ${enumName} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
    }
  );

  server.tool(
    'get_edt_details',
    'Extended Data Type details',
    { edtName: z.string() },
    async ({ edtName }) => {
      const obj = dbUtils.getObjectByName(db, edtName, 'Edt');
      if (!obj) return { content: [{ type: 'text', text: `Edt ${edtName} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
    }
  );

  server.tool(
    'get_form_datasources',
    'Form datasource and control info',
    { formName: z.string() },
    async ({ formName }) => {
      const obj = dbUtils.getObjectByName(db, formName, 'Form');
      if (!obj) return { content: [{ type: 'text', text: `Form ${formName} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
    }
  );

  server.tool(
    'get_element_xml',
    'Raw XML of any AOT object',
    { name: z.string(), type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']) },
    async ({ name, type }) => {
      const obj = dbUtils.getObjectByName(db, name, type);
      if (!obj) return { content: [{ type: 'text', text: `Object ${name} of type ${type} not found.` }] };
      return { content: [{ type: 'text', text: obj.raw_xml }] };
    }
  );

  server.tool(
    'list_objects',
    'List AOT objects',
    { type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Query', 'DataEntity', 'Edt']).optional(), package: z.string().optional(), offset: z.number().default(0), limit: z.number().default(50) },
    async ({ type, package: pkg, offset, limit }) => {
      const results = dbUtils.getAllObjects(db, type, pkg, offset, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
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
