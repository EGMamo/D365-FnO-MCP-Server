import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { openDb, type Database } from '../src/indexer/db.js';
import { KnowledgeSession } from '../src/knowledge/filter.js';
import { registerWithKnowledgeFilter } from '../src/knowledge/toolWrapper.js';
import { registerWithFileTargets } from '../src/workspace/fileTargets.js';
import { registerCodeQualityTools } from '../src/tools/codeQuality.js';
import { registerDocsTools } from '../src/tools/docs.js';
import { registerEntityTools } from '../src/tools/entities.js';
import { registerGeneratorTools } from '../src/tools/generators.js';
import { registerLabelsTools } from '../src/tools/labels.js';
import { registerMetadataTools } from '../src/tools/metadata.js';
import { registerTaskGuidanceTool } from '../src/tools/knowledge.js';
import { registerReleasePlanTools } from '../src/tools/releasePlans.js';
import { registerSecurityTools } from '../src/tools/security.js';
import { registerTelemetryTools } from '../src/tools/telemetry.js';
import { registerTraceTools } from '../src/tools/traces.js';
import { registerWorkspaceTools } from '../src/tools/workspace.js';
import { registerWriterTools } from '../src/tools/writers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The hints every other tool states, and the two tools that are not read-only (D365_ENABLE_WRITE_TOOLS
 * keeps them off by default). Spelled out here rather than imported, so changing READ_ONLY_TOOL or a
 * writer's literal has to change this test too.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITER_HINTS: Record<string, typeof READ_ONLY> = {
  write_table_extension: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  apply_table_extension_change: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};
const WRITER_TOOLS = Object.keys(WRITER_HINTS);

/**
 * Registered on the gateway's own tool collector, never on the McpServer that `serve` builds, so
 * the server below cannot list them. The collector drops the annotations it is given and the gateway
 * lists every local tool as read-only (asTool in src/gateway/server.ts); tests/gatewaySessionRelay.test.ts
 * checks what the gateway lists.
 */
const GATEWAY_ONLY_FILE = 'src/gateway/localTools.ts';

/**
 * These wrap server.tool and hand every argument, annotations included, on to the original. They
 * are the only places allowed to touch server.tool without calling it; the server below is built
 * through both, so a wrapper that dropped the annotations fails the runtime checks.
 */
const TOOL_WRAPPERS = new Set(['src/knowledge/toolWrapper.ts', 'src/workspace/fileTargets.ts']);

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

interface Registration {
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  name: string;
}

function sourceFiles(): string[] {
  return (fs.readdirSync(path.join(repoRoot, 'src'), { recursive: true }) as string[])
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => path.posix.join('src', entry.split(path.sep).join('/')))
    .sort();
}

/** Top-level `const NAME = 'text'` declarations, for a tool registered under a named constant. */
function stringConstants(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && initializer && ts.isStringLiteralLike(initializer)) {
        constants.set(name.text, initializer.text);
      }
    }
  }
  return constants;
}

/** The member a node reads, for `x.tool` and `x['tool']`. */
function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
}

/** READ_ONLY_TOOL, or an object literal that states readOnlyHint as a boolean. */
function isAnnotations(argument: ts.Expression | undefined): boolean {
  const node = argument && unwrap(argument);
  if (!node) return false;
  if (ts.isIdentifier(node)) return node.text === 'READ_ONLY_TOOL';
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'readOnlyHint' &&
      (property.initializer.kind === ts.SyntaxKind.TrueKeyword || property.initializer.kind === ts.SyntaxKind.FalseKeyword)
  );
}

/**
 * Every `<x>.tool(...)` call under src. The annotations of tool(name, description?, shape?,
 * annotations?, handler) sit right before the handler, so that is the argument read. Anything the
 * scan cannot read as a plain registration is reported as a problem instead of being skipped.
 */
function scanSources(): { registrations: Registration[]; problems: string[] } {
  const registrations: Registration[] = [];
  const problems: string[] = [];

  for (const file of sourceFiles()) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const constants = stringConstants(source);
    const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const at = (node: ts.Node) => `${file}:${line(node)}`;

    const visit = (node: ts.Node): void => {
      const member = memberName(node);
      if (member === 'registerTool') {
        problems.push(`${at(node)}: registerTool takes annotations in a config object, which this guard does not read; use tool(...)`);
      } else if (member === 'tool' && !TOOL_WRAPPERS.has(file)) {
        const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!called) {
          problems.push(`${at(node)}: server.tool is referenced without being called, so its registrations cannot be checked`);
        }
      }

      if (ts.isCallExpression(node) && memberName(node.expression) === 'tool') {
        const [first] = node.arguments;
        const name = first && (ts.isStringLiteralLike(first) ? first.text : ts.isIdentifier(first) ? constants.get(first.text) : undefined);
        if (name === undefined) {
          problems.push(`${at(node)}: the tool name is neither a string literal nor a string const in this file`);
        } else {
          registrations.push({ file, line: line(node), name });
          if (!isAnnotations(node.arguments.at(-2))) {
            problems.push(`${at(node)} ${name}: no annotations argument before the handler (pass READ_ONLY_TOOL, or a literal with readOnlyHint)`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { registrations, problems };
}

/**
 * Mirrors createMcpServer in src/server/start.ts, with the knowledge filter off and an empty index.
 * The write tools and get_task_guidance are registered too, so every tool the source can register
 * is listed. Everything the options point at lives under `root`.
 */
function createServer(db: Database, root: string): McpServer {
  const server = new McpServer({ name: 'tool-annotations', version: '0.0.0' });
  const session = new KnowledgeSession();
  registerWithKnowledgeFilter(server, () => null, () => {
    registerMetadataTools(server, db, { sourceFilesAvailable: true });
    registerLabelsTools(server, db);
    registerTraceTools(server, db);
    registerTelemetryTools(server, db);
    registerCodeQualityTools(server, db);
    registerReleasePlanTools(server, db);
    registerDocsTools(server, db);
    // A custom metadata folder switches the file-target wrapper on, as it is on a local server.
    registerWithFileTargets(server, {
      customMetadataDir: root,
      targetModel: '',
      targetPackage: '',
      writableModels: [],
      workspaceDir: '',
      targetSolution: '',
      targetProject: '',
    }, () => {
      registerSecurityTools(server, db);
      registerEntityTools(server, db);
      registerGeneratorTools(server, db);
    });
  }, session);
  registerTaskGuidanceTool(server, () => null, session);
  // Test only: the writers are registered so their annotations can be read; nothing is written.
  registerWriterTools(server, db, { enableWriteTools: true, projectDir: root, customMetadataDir: root, writableModels: [] });
  registerWorkspaceTools(server, {
    workspaceDir: '',
    customMetadataDir: root,
    targetProject: '',
    targetPackage: '',
    targetModel: '',
    targetSolution: '',
    writableModels: [],
    projectDir: root,
    enableWriteTools: true,
  });
  return server;
}

async function listServerTools(): Promise<Tool[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-tool-annotations-'));
  let db: Database | undefined;
  let server: McpServer | undefined;
  const client = new Client({ name: 'tool-annotations-client', version: '0.0.0' });
  try {
    db = openDb(':memory:');
    server = createServer(db, root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server?.close();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const scan = scanSources();

describe('tool registrations in the source', () => {
  it('finds registrations to check', () => {
    expect(scan.registrations).not.toHaveLength(0);
  });

  it('passes annotations at every one, and registers tools only through a direct .tool(...) call', () => {
    expect(scan.problems).toEqual([]);
  });
});

describe('tools listed by a running server', () => {
  let listed: Tool[];
  beforeAll(async () => {
    listed = await listServerTools();
  });

  it('lists exactly the tools the source registers for the server', () => {
    const registered = scan.registrations.filter(({ file }) => file !== GATEWAY_ONLY_FILE).map(({ name }) => name);
    expect(
      listed.map(({ name }) => name).sort(),
      'createServer in this file mirrors createMcpServer in src/server/start.ts; keep the two in step'
    ).toEqual(registered.sort());
  });

  it('states all four hints as booleans on every tool', () => {
    const incomplete = listed
      .filter((tool) => HINTS.some((hint) => typeof tool.annotations?.[hint] !== 'boolean'))
      .map(({ name }) => name);
    expect(incomplete).toEqual([]);
  });

  it('gives every tool except the two writers exactly the read-only hints', () => {
    const wrong = listed
      .filter(({ name }) => !WRITER_TOOLS.includes(name))
      .filter(({ annotations }) => HINTS.some((hint) => annotations?.[hint] !== READ_ONLY[hint]))
      .map(({ name }) => name);
    expect(wrong).toEqual([]);
  });

  it('gives the two writers their own hints, and nothing else is left without read-only', () => {
    for (const [name, hints] of Object.entries(WRITER_HINTS)) {
      const tool = listed.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations, name).toEqual(hints);
    }
    const notReadOnly = listed.filter(({ annotations }) => annotations?.readOnlyHint !== true).map(({ name }) => name);
    expect(notReadOnly.sort()).toEqual([...WRITER_TOOLS].sort());
  });
});
