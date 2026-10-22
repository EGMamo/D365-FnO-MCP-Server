import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from './generators.js';

/**
 * Generated files travel as an extra JSON text item on a generator's result, after its usual text.
 * The item names each AOT file and holds its full content; nothing is ever written. Where the custom
 * metadata folder is configured (local `serve`, the hybrid gateway), `addFileTargets` adds where each
 * file belongs, so the agent can save it with its own editing tools.
 */
export const GENERATED_FILES_KEY = 'generatedFiles';

export interface GeneratedFile {
  /** AOT folder name, e.g. AxClass, AxTableExtension, AxSecurityPrivilege. */
  aotType: string;
  /** Element name; also the file name without `.xml`. */
  name: string;
  /** Complete file content, ready to save. */
  content: string;
}

export interface GeneratedFilesPayload {
  [GENERATED_FILES_KEY]: (GeneratedFile & { target?: unknown })[];
  save: string;
  targets?: unknown;
}

const SAVE_NOTE =
  'Nothing has been written. Save each file as <custom metadata folder>\\<Package>\\<Model>\\<aotType>\\<name>.xml ' +
  'and add it to the Finance and Operations project. Where a target is given, use its path and projectItem. ' +
  'In Visual Studio, pass the saved paths to workspace_add_to_project to add them without a project reload.';

const AOT_TYPE = /^Ax[A-Za-z]+$/;

/** Appends the files item to a successful result; errors and empty lists pass through unchanged. */
export function withGeneratedFiles(result: ToolResult, files: GeneratedFile[]): ToolResult {
  if (result.isError || files.length === 0) return result;
  for (const file of files) {
    if (!AOT_TYPE.test(file.aotType)) throw new Error(`Invalid AOT type for a generated file: ${file.aotType}`);
  }
  const payload: GeneratedFilesPayload = { [GENERATED_FILES_KEY]: files, save: SAVE_NOTE };
  return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify(payload) }] };
}

/** Finds the files item in a result (a local one or one returned by the hosted server). */
export function readGeneratedFiles(result: CallToolResult): { index: number; payload: GeneratedFilesPayload } | null {
  if (result.isError || !Array.isArray(result.content)) return null;
  for (let index = result.content.length - 1; index >= 0; index--) {
    const item = result.content[index];
    if (item.type !== 'text' || !item.text.startsWith(`{"${GENERATED_FILES_KEY}":`)) continue;
    try {
      const payload = JSON.parse(item.text) as GeneratedFilesPayload;
      const files = payload[GENERATED_FILES_KEY];
      if (!Array.isArray(files)) return null;
      const valid = files.every((file) =>
        file && typeof file.name === 'string' && typeof file.content === 'string' &&
        typeof file.aotType === 'string' && AOT_TYPE.test(file.aotType));
      return valid ? { index, payload } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** CDATA section for X++ source; a literal `]]>` is split across two sections. */
function cdata(text: string): string {
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

function escapeName(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface XppMethod {
  name: string;
  /** Source lines as they appear inside the class body (indented by four spaces). */
  lines: string[];
}

export interface XppClassParts {
  name: string;
  /** Comment and attribute lines followed by the class declaration line (`final class X extends Y`). */
  declaration: string[];
  /** Member lines inside the braces, before the methods (variables, macros). */
  members?: string[];
  methods?: XppMethod[];
}

/** The class as one X++ listing: declaration, members, then methods separated by blank lines. */
export function xppClassText(parts: XppClassParts): string {
  const members = parts.members ?? [];
  const methods = (parts.methods ?? []).map((method) => method.lines.join('\n'));
  const body = [...(members.length ? [members.join('\n')] : []), ...methods].join('\n\n');
  return [...parts.declaration, '{', ...(body ? [body] : []), '}'].join('\n');
}

/** The same class as an AxClass metadata file: declaration and members, then one entry per method. */
export function axClassFile(parts: XppClassParts): GeneratedFile {
  const tab = '\t';
  const declaration = [...parts.declaration, '{', ...(parts.members ?? []), '}'].join('\n');
  const methods = parts.methods ?? [];
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    `${tab}<Name>${escapeName(parts.name)}</Name>`,
    `${tab}<SourceCode>`,
    `${tab}${tab}<Declaration>${cdata(`\n${declaration}\n`)}</Declaration>`,
    ...(methods.length
      ? [
          `${tab}${tab}<Methods>`,
          ...methods.flatMap((method) => [
            `${tab}${tab}${tab}<Method>`,
            `${tab}${tab}${tab}${tab}<Name>${escapeName(method.name)}</Name>`,
            `${tab}${tab}${tab}${tab}<Source>${cdata(`\n${method.lines.join('\n')}\n\n`)}</Source>`,
            `${tab}${tab}${tab}</Method>`,
          ]),
          `${tab}${tab}</Methods>`,
        ]
      : [`${tab}${tab}<Methods />`]),
    `${tab}</SourceCode>`,
    '</AxClass>',
  ];
  return { aotType: 'AxClass', name: parts.name, content: lines.join('\n') + '\n' };
}
