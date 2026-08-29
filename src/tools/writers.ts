import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Database } from 'better-sqlite3';
import { z } from 'zod';
import { resolveAnyObject, validateNaming } from '../validation/grounding.js';
import { generateTableExtensionXml } from './generators.js';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(lines: string | string[]): ToolResult {
  const text = Array.isArray(lines) ? lines.join('\n') : lines;
  return { content: [{ type: 'text', text }], isError: true };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export interface WriterOptions {
  /** Master feature flag. Tools are only registered when true. */
  enableWriteTools: boolean;
  /** Root directory that every write must stay inside. */
  projectDir: string;
}

/** Segment must be a plain directory name: no separators, no traversal, no drive letters. */
function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..';
}

export function registerWriterTools(server: McpServer, db: Database, options: WriterOptions) {
  if (options.enableWriteTools !== true) return;

  const projectRoot = path.resolve(options.projectDir);

  server.tool(
    'write_table_extension',
    'Write a grounded table extension XML file into the configured project directory (feature-flagged)',
    {
      tableName: z.string(),
      extensionName: z.string(),
      packageName: z.string(),
      modelName: z.string(),
      fields: z.array(
        z.object({
          name: z.string(),
          edt: z.string().min(1),
          labelId: z.string().optional(),
          mandatory: z.boolean().optional(),
          allowEdit: z.boolean().optional(),
        })
      ),
      properties: z
        .object({
          labelId: z.string().optional(),
          saveDataPerCompany: z.boolean().optional(),
        })
        .optional(),
    },
    async ({ tableName, extensionName, packageName, modelName, fields, properties }) => {
      const extNaming = validateNaming(extensionName);
      if (!extNaming.ok) return fail(`Invalid extension name: ${extNaming.error}`);

      const existing = resolveAnyObject(db, extensionName);
      if (existing) {
        return fail(
          `Grounding failed: an object named '${extensionName}' already exists in the index as ${existing.type}. Choose a different extension name.`
        );
      }

      // Grounding: target table, EDTs, field naming, duplicates and XML generation.
      const generated = generateTableExtensionXml(db, {
        targetTable: tableName,
        extensionName,
        fields: fields.map((f) => ({
          name: f.name,
          edt: f.edt,
          label: f.labelId,
          mandatory: f.mandatory,
          allowEdit: f.allowEdit,
        })),
        properties,
      });
      if (generated.isError) return generated;
      const xml = generated.content[0]?.text ?? '';

      if (!isSafeSegment(packageName) || !isSafeSegment(modelName) || !isSafeSegment(extensionName)) {
        return fail(
          'Write rejected: packageName, modelName and extensionName must be simple names without path separators or traversal segments.'
        );
      }

      const targetPath = path.resolve(
        projectRoot,
        packageName,
        modelName,
        'AxTableExtension',
        `${extensionName}.xml`
      );
      if (!targetPath.startsWith(projectRoot + path.sep)) {
        return fail(
          `Write rejected: resolved path escapes the configured project directory '${projectRoot}'.`
        );
      }

      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, xml, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if (isNodeError(err) && err.code === 'EEXIST') {
          return fail(`Write rejected: '${targetPath}' already exists. Refusing to overwrite.`);
        }
        return fail(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return ok(
        JSON.stringify({ written: true, path: targetPath, extensionName, table: tableName }, null, 2)
      );
    }
  );
}
