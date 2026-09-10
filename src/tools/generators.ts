import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../indexer/db.js';
import { z } from 'zod';
import {
  extractParamNames,
  resolveClass,
  resolveEdt,
  resolveLabel,
  validateCoCTarget,
  validateMethodSignature,
  validateNaming,
  validateTableFieldEdts,
} from '../validation/grounding.js';
import * as dbUtils from '../indexer/db.js';

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

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlCommentSafe(value: string): string {
  // Angle brackets are escaped and every '-' is padded, so neither '--' nor '-->'
  // can ever be formed inside the generated comment.
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/-/g, '- ')
    .replace(/[\r\n]+/g, ' ');
}

export interface TableExtensionFieldSpec {
  name: string;
  edt: string;
  label?: string;
  mandatory?: boolean;
  allowEdit?: boolean;
}

export interface TableExtensionIndexSpec {
  name: string;
  fields: string[];
  allowDuplicates?: boolean;
}

export interface TableExtensionProperties {
  labelId?: string;
  saveDataPerCompany?: boolean;
}

export interface TableExtensionSpec {
  targetTable: string;
  extensionName: string;
  fields?: TableExtensionFieldSpec[];
  indexes?: TableExtensionIndexSpec[];
  properties?: TableExtensionProperties;
}

/**
 * Pure generator for AxTableExtension XML. Performs all grounding/validation and
 * returns a ToolResult whose text is either the XML or the failure message.
 */
export function generateTableExtensionXml(
  db: Database,
  { targetTable, extensionName, fields, indexes, properties }: TableExtensionSpec
): ToolResult {
    const naming = validateNaming(extensionName);
    if (!naming.ok) return fail(`Invalid extension name: ${naming.error}`);

    const table = dbUtils.getObjectByName(db, targetTable, 'Table');
    if (!table) {
      return fail(
        `Grounding failed: target table '${targetTable}' was not found in the index. Cannot generate a table extension for a non-existent table.`
      );
    }

    const fieldList = fields ?? [];
    const seenNames = new Map<string, string>();
    const duplicates: string[] = [];
    for (const f of fieldList) {
      const key = f.name.toLowerCase();
      if (seenNames.has(key)) duplicates.push(f.name);
      else seenNames.set(key, f.name);
    }
    if (duplicates.length > 0) {
      return fail(
        `Grounding failed: duplicate field name(s) ${duplicates
          .map((n) => `'${n}'`)
          .join(', ')} were requested more than once in this extension.`
      );
    }

    const fieldCheck = validateTableFieldEdts(db, fieldList);
    if (!fieldCheck.ok) return fail(['Grounding failed:', ...fieldCheck.errors]);

    const existingFields = new Set(
      (table.fields as { name: string }[]).map((f) => f.name.toLowerCase())
    );
    const collisions = fieldList.filter((f) => existingFields.has(f.name.toLowerCase()));
    if (collisions.length > 0) {
      return fail(
        `Grounding failed: field(s) ${collisions
          .map((f) => `'${f.name}'`)
          .join(', ')} already exist on table '${targetTable}'.`
      );
    }

    const labelErrors: string[] = [];
    for (const f of fieldList) {
      if (f.label && f.label.startsWith('@') && !resolveLabel(db, f.label)) {
        labelErrors.push(`Field '${f.name}': label '${f.label}' was not found in the label index.`);
      }
    }
    if (labelErrors.length > 0) return fail(['Grounding failed:', ...labelErrors]);

    const idxList = indexes ?? [];
    const knownAfterExtension = new Set([
      ...existingFields,
      ...fieldList.map((f) => f.name.toLowerCase()),
    ]);
    const idxErrors: string[] = [];
    for (const idx of idxList) {
      const idxNaming = validateNaming(idx.name);
      if (!idxNaming.ok) idxErrors.push(`Index '${idx.name}': ${idxNaming.error}`);
      if (!idx.fields || idx.fields.length === 0) {
        idxErrors.push(`Index '${idx.name}': at least one field is required.`);
      }
      for (const fn of idx.fields ?? []) {
        if (!knownAfterExtension.has(fn.toLowerCase())) {
          idxErrors.push(
            `Index '${idx.name}': field '${fn}' does not exist on '${targetTable}' and is not added by this extension.`
          );
        }
      }
    }
    if (idxErrors.length > 0) return fail(['Grounding failed:', ...idxErrors]);

    const VALID_FIELD_TYPES = new Set([
      'String', 'Int', 'Int64', 'Real', 'Date', 'Time', 'UtcDateTime', 'Enum', 'Guid',
      'Container', 'Memo', 'Blob', 'Boolean',
    ]);
    const edtWarnings: string[] = [];
    const fieldXml = fieldList
      .map((f) => {
        const edt = resolveEdt(db, f.edt);
        const rawType = (edt?.properties?.edtType || '').trim();
        let edtType = rawType;
        if (!edtType || edtType === 'Unknown' || !VALID_FIELD_TYPES.has(edtType)) {
          edtWarnings.push(
            `Field '${f.name}': EDT '${f.edt}' has an unresolved base type${rawType ? ` ('${rawType}')` : ''}; defaulted to String. Verify before deployment.`
          );
          edtType = 'String';
        }
        return [
          `    <AxTableField xmlns=""  i:type="AxTableField${edtType}">`,
          `      <Name>${xmlEscape(f.name)}</Name>`,
          f.label ? `      <Label>${xmlEscape(f.label)}</Label>` : '',
          f.mandatory === true ? `      <Mandatory>Yes</Mandatory>` : '',
          f.allowEdit === false ? `      <AllowEdit>No</AllowEdit>` : '',
          `      <ExtendedDataType>${xmlEscape(f.edt)}</ExtendedDataType>`,
          `    </AxTableField>`,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    const indexXml = idxList
      .map((idx) => {
        const idxFields = idx.fields
          .map(
            (fn) =>
              `        <AxTableIndexField>\n          <DataField>${xmlEscape(fn)}</DataField>\n        </AxTableIndexField>`
          )
          .join('\n');
        return [
          `    <AxTableIndex>`,
          `      <Name>${xmlEscape(idx.name)}</Name>`,
          `      <AllowDuplicates>${idx.allowDuplicates ? 'Yes' : 'No'}</AllowDuplicates>`,
          `      <Fields>`,
          idxFields,
          `      </Fields>`,
          `    </AxTableIndex>`,
        ].join('\n');
      })
      .join('\n');

    const xml = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      ...edtWarnings.map((w) => `<!-- WARNING: ${xmlCommentSafe(w)} -->`),
      `<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`,
      `  <Name>${xmlEscape(targetTable)}.${xmlEscape(extensionName)}</Name>`,
      properties?.labelId ? `  <LabelId>${xmlEscape(properties.labelId)}</LabelId>` : '',
      properties?.saveDataPerCompany !== undefined
        ? `  <SaveDataPerCompany>${properties.saveDataPerCompany ? 'Yes' : 'No'}</SaveDataPerCompany>`
        : '',
      `  <Fields>`,
      fieldXml,
      `  </Fields>`,
      `  <FullTextIndexes />`,
      `  <Indexes>`,
      indexXml,
      `  </Indexes>`,
      `  <Mappings />`,
      `  <Relations />`,
      `</AxTableExtension>`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return ok(xml);
}

export function registerGeneratorTools(server: McpServer, db: Database) {
  server.tool(
    'create_coc_extension',
    'Create an X++ Chain of Command extension class (grounded against the index)',
    {
      targetClass: z.string(),
      extensionName: z.string(),
      methods: z.array(
        z.object({
          name: z.string(),
          params: z.string().optional(),
          returnType: z.string().optional(),
        })
      ),
    },
    async ({ targetClass, extensionName, methods }) => {
      const naming = validateNaming(extensionName);
      if (!naming.ok) return fail(`Invalid extension name: ${naming.error}`);

      const target = validateCoCTarget(db, targetClass);
      if (!target.ok || !target.object) return fail(`Grounding failed: ${target.error}`);

      if (!methods || methods.length === 0) {
        return fail('Grounding failed: at least one method must be supplied for a Chain of Command extension.');
      }

      const nameErrors = methods
        .map((m) => ({ m, r: validateNaming(m.name) }))
        .filter((x) => !x.r.ok)
        .map((x) => `Method '${x.m.name}': ${x.r.error}`);
      if (nameErrors.length > 0) return fail(['Grounding failed:', ...nameErrors]);

      const seenMethodNames = new Map<string, string>();
      const duplicateMethods: string[] = [];
      for (const m of methods) {
        const key = m.name.toLowerCase();
        if (seenMethodNames.has(key)) duplicateMethods.push(m.name);
        else seenMethodNames.set(key, m.name);
      }
      if (duplicateMethods.length > 0) {
        return fail(
          `Grounding failed: duplicate method name(s) ${duplicateMethods
            .map((n) => `'${n}'`)
            .join(', ')} were requested more than once; the generated class would not compile.`
        );
      }

      const obj = target.object;
      const wrapperKind = obj.type === 'Table' ? 'tableStr' : obj.type === 'Form' ? 'formStr' : 'classStr';

      const signatureErrors: string[] = [];
      const resolved = methods.map((m) => {
        const existing = validateMethodSignature(db, targetClass, m.name);
        if (!existing) {
          signatureErrors.push(
            `Method '${m.name}' does not exist on ${obj.type} ${obj.name} or any of its base classes. Chain of Command can only wrap existing methods; 'next ${m.name}(...)' would not compile.`
          );
          return null;
        }

        const indexedParams = Array.isArray(existing.params)
          ? (existing.params as { name?: string; type?: string }[])
          : [];
        const indexedReturn = existing.return_type || 'void';
        const accessModifier = (existing.access_modifier || 'public').toLowerCase();

        if (accessModifier === 'private') {
          signatureErrors.push(
            `Method '${m.name}': ${existing.declaring_object ?? obj.name}.${existing.name} is private. Chain of Command can only wrap public or protected methods.`
          );
          return null;
        }

        if (m.params !== undefined) {
          const supplied = extractParamNames(m.params);
          if (supplied.length !== indexedParams.length) {
            signatureErrors.push(
              `Method '${m.name}': supplied ${supplied.length} parameter(s) but ${existing.declaring_object ?? obj.name}.${existing.name} declares ${indexedParams.length}.`
            );
            return null;
          }
        }
        if (m.returnType && m.returnType.toLowerCase() !== indexedReturn.toLowerCase()) {
          signatureErrors.push(
            `Method '${m.name}': supplied return type '${m.returnType}' does not match the indexed return type '${indexedReturn}'.`
          );
          return null;
        }

        // Prefer the indexed signature over caller input so the wrapper always matches the base.
        const params = indexedParams
          .map((p) => `${p.type ? `${p.type} ` : ''}${p.name ?? ''}`.trim())
          .filter(Boolean)
          .join(', ');
        return { name: existing.name, params, returnType: indexedReturn, accessModifier, existing };
      });
      if (signatureErrors.length > 0) return fail(['Grounding failed:', ...signatureErrors]);

      const methodsCode = resolved
        .map((r) => {
          const m = r as NonNullable<typeof r>;
          const declaredOn = m.existing.declaring_object ?? obj.name;
          const inheritedNote = declaredOn.toLowerCase() === obj.name.toLowerCase() ? '' : ` inherited from ${declaredOn}`;
          const isStatic = m.existing.is_static === 1;
          const staticPrefix = isStatic ? 'static ' : '';
          const marker = `        // Wraps ${obj.name}.${m.existing.name}${inheritedNote} (${m.accessModifier} ${staticPrefix}${m.returnType})`;
          const args = extractParamNames(m.params).join(', ');
          // Static Chain of Command still forwards through `next methodName(args);`.
          const nextCall = `next ${m.name}(${args});`;
          const body =
            m.returnType === 'void'
              ? `        ${nextCall}`
              : `        ${m.returnType} ret = ${nextCall}\n\n        return ret;`;
          return `${marker}\n    ${m.accessModifier} ${staticPrefix}${m.returnType} ${m.name}(${m.params})\n    {\n${body}\n    }`;
        })
        .join('\n\n');

      const inherits = [
        obj.properties?.extends ? `extends ${obj.properties.extends}` : '',
        obj.properties?.implements ? `implements ${obj.properties.implements}` : '',
      ]
        .filter(Boolean)
        .join(' ');

      const header = [
        `// Generated by D365 FnO MCP Server`,
        `// Target: ${obj.type} ${obj.name} (package ${obj.package})`,
        inherits ? `// Target declaration: ${obj.name} ${inherits}` : `// Target declaration: ${obj.name}`,
      ].join('\n');

      const template = `${header}\n[ExtensionOf(${wrapperKind}(${obj.name}))]\nfinal class ${extensionName}\n{\n${methodsCode}\n}`;
      return ok(template);
    }
  );

  server.tool(
    'create_table_extension',
    'Create a table extension with real XML, grounded against the index',
    {
      targetTable: z.string(),
      extensionName: z.string(),
      fields: z
        .array(
          z.object({
            name: z.string(),
            edt: z.string().min(1),
            label: z.string().optional(),
            mandatory: z.boolean().optional(),
            allowEdit: z.boolean().optional(),
          })
        )
        .optional(),
      indexes: z
        .array(
          z.object({
            name: z.string(),
            fields: z.array(z.string()),
            allowDuplicates: z.boolean().optional(),
          })
        )
        .optional(),
      properties: z
        .object({
          labelId: z.string().optional(),
          saveDataPerCompany: z.boolean().optional(),
        })
        .optional(),
    },
    async ({ targetTable, extensionName, fields, indexes, properties }) =>
      generateTableExtensionXml(db, { targetTable, extensionName, fields, indexes, properties })
  );

  server.tool(
    'create_class_extension',
    'Create X++ class extension boilerplate, grounded against the index',
    { targetClass: z.string(), extensionName: z.string() },
    async ({ targetClass, extensionName }) => {
      const naming = validateNaming(extensionName);
      if (!naming.ok) return fail(`Invalid extension name: ${naming.error}`);

      const target = validateCoCTarget(db, targetClass);
      if (!target.ok || !target.object) return fail(`Grounding failed: ${target.error}`);

      const obj = target.object;
      const wrapperKind = obj.type === 'Table' ? 'tableStr' : obj.type === 'Form' ? 'formStr' : 'classStr';
      const template = [
        `// Generated by D365 FnO MCP Server`,
        `// Target: ${obj.type} ${obj.name} (package ${obj.package})`,
        `[ExtensionOf(${wrapperKind}(${obj.name}))]`,
        `final class ${extensionName}`,
        `{`,
        `}`,
      ].join('\n');
      return ok(template);
    }
  );

  server.tool(
    'generate_xpp_class',
    'Generate standard X++ class, grounded against the index',
    {
      className: z.string(),
      extends: z.string().optional(),
      implements: z.array(z.string()).optional(),
      isAbstract: z.boolean().optional(),
      description: z.string().optional(),
    },
    async ({ className, extends: ext, implements: impl, isAbstract, description }) => {
      const naming = validateNaming(className);
      if (!naming.ok) return fail(`Invalid class name: ${naming.error}`);

      const errors: string[] = [];
      if (ext && !resolveClass(db, ext)) {
        errors.push(`Parent class '${ext}' was not found in the index as a Class.`);
      }
      for (const iface of impl ?? []) {
        if (!resolveClass(db, iface)) {
          errors.push(`Interface '${iface}' was not found in the index as a Class.`);
        }
      }
      if (errors.length > 0) return fail(['Grounding failed:', ...errors]);

      let decl = `${isAbstract ? 'abstract ' : ''}class ${className}`;
      if (ext) decl += ` extends ${ext}`;
      if (impl && impl.length) decl += ` implements ${impl.join(', ')}`;

      const template = `/// <summary>\n/// ${description || 'Generated class'}\n/// </summary>\n${decl}\n{\n}`;
      return ok(template);
    }
  );

  server.tool(
    'create_runbase_batch',
    'Create RunBaseBatch framework class',
    { className: z.string(), description: z.string(), menuItemName: z.string().optional() },
    async ({ className, description, menuItemName }) => {
      const naming = validateNaming(className);
      if (!naming.ok) return fail(`Invalid class name: ${naming.error}`);
      if (menuItemName) {
        const miNaming = validateNaming(menuItemName);
        if (!miNaming.ok) return fail(`Invalid menu item name: ${miNaming.error}`);
      }

      const template = [
        `/// <summary>`,
        `/// ${description}`,
        `/// </summary>`,
        menuItemName ? `// Menu item: ${menuItemName}` : '',
        `class ${className} extends RunBaseBatch`,
        `{`,
        `    #define.CurrentVersion(1)`,
        ``,
        `    public container pack()`,
        `    {`,
        `        return [#CurrentVersion];`,
        `    }`,
        ``,
        `    public boolean unpack(container _packedClass)`,
        `    {`,
        `        int version = conPeek(_packedClass, 1);`,
        `        return version == #CurrentVersion;`,
        `    }`,
        ``,
        `    public void run()`,
        `    {`,
        `    }`,
        ``,
        `    public static void main(Args _args)`,
        `    {`,
        `        ${className} batch = new ${className}();`,
        ``,
        `        if (batch.prompt())`,
        `        {`,
        `            batch.runOperation();`,
        `        }`,
        `    }`,
        `}`,
      ]
        .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
        .join('\n');
      return ok(template);
    }
  );

  server.tool(
    'create_sys_operation',
    'Create SysOperation framework classes',
    { baseName: z.string(), description: z.string(), menuItemName: z.string().optional() },
    async ({ baseName, description, menuItemName }) => {
      const naming = validateNaming(baseName);
      if (!naming.ok) return fail(`Invalid base name: ${naming.error}`);
      for (const suffix of ['Contract', 'Service', 'Controller', 'UIBuilder']) {
        const derived = validateNaming(`${baseName}${suffix}`);
        if (!derived.ok) return fail(`Invalid generated class name: ${derived.error}`);
      }
      if (menuItemName) {
        const miNaming = validateNaming(menuItemName);
        if (!miNaming.ok) return fail(`Invalid menu item name: ${miNaming.error}`);
      }

      const result = {
        description,
        menuItemName: menuItemName ?? null,
        contract: `[DataContractAttribute]\nclass ${baseName}Contract\n{\n}`,
        service: `class ${baseName}Service\n{\n    public void process(${baseName}Contract _contract)\n    {\n    }\n}`,
        controller: `class ${baseName}Controller extends SysOperationServiceController\n{\n    public static void main(Args _args)\n    {\n        ${baseName}Controller controller = new ${baseName}Controller();\n        controller.startOperation();\n    }\n}`,
        uiBuilder: `class ${baseName}UIBuilder extends SysOperationAutomaticUIBuilder\n{\n    public void build()\n    {\n        super();\n    }\n}`,
      };
      return ok(JSON.stringify(result, null, 2));
    }
  );
}
