import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

/** Source files the developer package must never contain. */
const OPERATOR_ONLY: readonly RegExp[] = [
  /^index\.ts$/,
  /^config\.ts$/,
  /^configLoader\.ts$/,
  /^server\/start\.ts$/,
  /^server\/keyRegistry.*\.ts$/,
  /^server\/adminRoutes\.ts$/,
  /^server\/adminPage\.ts$/,
  /^cli\/keys\.ts$/,
  /^cli\/deploy.*\.ts$/,
  /^cli\/.*-command\.ts$/,
  /^cli\/digest\.ts$/,
  /^knowledge\//,
  /^indexer\/artifact.*\.ts$/,
  /^indexer\/azureBlobArtifactStore.*\.ts$/,
];

const BANNED_PACKAGES: readonly RegExp[] = [/^@azure\//, /^onnxruntime-web$/, /^@huggingface\//];

/** The program the developer build compiles, as `src`-relative paths, and its bare imports. */
function clientProgram(): { files: string[]; bareImports: Set<string> } {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.client.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error('tsconfig.client.json could not be read');
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const files: string[] = [];
  const bareImports = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(src + path.sep) && !sf.fileName.startsWith(src + '/')) continue;
    files.push(path.relative(src, sf.fileName).split(path.sep).join('/'));
    const visit = (node: ts.Node): void => {
      let spec: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        spec = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) spec = arg.text;
      }
      if (spec && !spec.startsWith('.') && !spec.startsWith('node:')) {
        const parts = spec.split('/');
        bareImports.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files, bareImports };
}

const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'url', 'http', 'https', 'net', 'events', 'stream', 'util', 'child_process', 'readline', 'zlib', 'assert', 'buffer', 'timers', 'worker_threads', 'module', 'process', 'tty', 'dns', 'string_decoder', 'perf_hooks', 'async_hooks', 'v8', 'vm']);

describe('developer package boundary', () => {
  const { files, bareImports } = clientProgram();

  it('starts from the developer entry point', () => {
    expect(files).toContain('clientIndex.ts');
  });

  it('contains no operator-only source file', () => {
    const leaked = files.filter((f) => OPERATOR_ONLY.some((re) => re.test(f)));
    expect(leaked).toEqual([]);
  });

  it('imports no banned package and only root dependencies (optional ones are loaded lazily and not shipped)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const external = [...bareImports].filter((name) => !NODE_BUILTINS.has(name));
    expect(external.filter((name) => BANNED_PACKAGES.some((re) => re.test(name)))).toEqual([]);
    const known = { ...pkg.dependencies, ...pkg.optionalDependencies };
    expect(external.filter((name) => !(name in known))).toEqual([]);
  });
});
