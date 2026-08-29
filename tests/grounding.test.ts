import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  extractParamNames,
  resolveClass,
  resolveClassOrTable,
  resolveEdt,
  resolveLabel,
  validateCoCTarget,
  validateMethodSignature,
  validateNaming,
  validateTableFieldEdts,
} from '../src/validation/grounding.js';
import { seedDb } from './helpers/toolHarness.js';

let db: Database;

beforeAll(() => {
  db = seedDb(
    [
      {
        type: 'Class',
        name: 'SalesLineType',
        properties: { extends: 'SalesLineTypeBase', implements: 'SysPackable' },
        methods: [
          { name: 'insert', accessModifier: 'public', returnType: 'void', params: [] },
          {
            name: 'validateWrite',
            accessModifier: 'public',
            returnType: 'boolean',
            params: [{ name: '_line', type: 'SalesLine' }],
          },
        ],
      },
      {
        type: 'Class',
        name: 'SalesLineTypeBase',
        methods: [
          {
            name: 'baseOnly',
            accessModifier: 'public',
            returnType: 'str',
            params: [{ name: '_arg', type: 'int' }],
          },
          {
            name: 'baseProtectedStatic',
            accessModifier: 'protected',
            returnType: 'void',
            params: [],
            isStatic: true,
          },
        ],
      },
      { type: 'Class', name: 'SalesLineTypeDerived', properties: { extends: 'SalesLineType' } },
      { type: 'Class', name: 'CycleA', properties: { extends: 'CycleB' } },
      { type: 'Class', name: 'CycleB', properties: { extends: 'CycleA' } },
      {
        type: 'Class',
        name: 'MentionsExtensionOf',
        raw_xml:
          '<AxClass><Name>MentionsExtensionOf</Name><Source>// this class is not an ExtensionOf anything\nclass MentionsExtensionOf {}</Source></AxClass>',
      },
      { type: 'Class', name: 'SysPackable' },
      {
        type: 'Class',
        name: 'SalesLineType_Extension',
        raw_xml: '<AxClass><Name>SalesLineType_Extension</Name><Source>[ExtensionOf(classStr(SalesLineType))]</Source></AxClass>',
      },
      {
        type: 'Table',
        name: 'CustTable',
        fields: [{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }],
      },
      { type: 'Edt', name: 'CustAccount', properties: { edtType: 'String', stringSize: '20' } },
      { type: 'Edt', name: 'AmountMST', properties: { edtType: 'Real' } },
    ],
    [{ labelId: 'SYS1', value: 'Account' }]
  );
});

afterAll(() => db.close());

describe('resolveClassOrTable', () => {
  it('resolves a class', () => {
    expect(resolveClassOrTable(db, 'SalesLineType')?.type).toBe('Class');
  });
  it('resolves a table when no class matches', () => {
    expect(resolveClassOrTable(db, 'CustTable')?.type).toBe('Table');
  });
  it('returns null for unknown names', () => {
    expect(resolveClassOrTable(db, 'NoSuchThing')).toBeNull();
  });
});

describe('resolveClass', () => {
  it('resolves a class', () => {
    expect(resolveClass(db, 'SalesLineType')?.type).toBe('Class');
  });
  it('does not resolve non-class objects', () => {
    expect(resolveClass(db, 'CustTable')).toBeNull();
    expect(resolveClass(db, 'CustAccount')).toBeNull();
  });
});

describe('extractParamNames', () => {
  it('strips default values', () => {
    expect(extractParamNames("boolean _skip = false, str _s = '', int _i = 0")).toEqual([
      '_skip',
      '_s',
      '_i',
    ]);
  });
  it('handles plain and empty lists', () => {
    expect(extractParamNames('SalesLine _line')).toEqual(['_line']);
    expect(extractParamNames('')).toEqual([]);
  });
});

describe('resolveEdt / resolveLabel', () => {
  it('resolves a known EDT', () => {
    expect(resolveEdt(db, 'CustAccount')?.name).toBe('CustAccount');
  });
  it('returns null for unknown EDTs', () => {
    expect(resolveEdt(db, 'BogusEdt')).toBeNull();
  });
  it('resolves labels with and without @', () => {
    expect(resolveLabel(db, 'SYS1')).toBe('Account');
    expect(resolveLabel(db, '@SYS1')).toBe('Account');
    expect(resolveLabel(db, '@SYS999999')).toBeNull();
  });
});

describe('validateMethodSignature', () => {
  it('finds an existing method', () => {
    expect(validateMethodSignature(db, 'SalesLineType', 'insert')?.name).toBe('insert');
  });
  it('is case-insensitive', () => {
    expect(validateMethodSignature(db, 'SalesLineType', 'INSERT')).not.toBeNull();
  });
  it('honours expected parameter count', () => {
    expect(validateMethodSignature(db, 'SalesLineType', 'validateWrite', 1)).not.toBeNull();
    expect(validateMethodSignature(db, 'SalesLineType', 'validateWrite', 3)).toBeNull();
  });
  it('returns null for unknown methods or objects', () => {
    expect(validateMethodSignature(db, 'SalesLineType', 'nope')).toBeNull();
    expect(validateMethodSignature(db, 'Nope', 'insert')).toBeNull();
  });
  it('resolves methods inherited from a base class', () => {
    const m = validateMethodSignature(db, 'SalesLineTypeDerived', 'baseOnly');
    expect(m?.name).toBe('baseOnly');
    expect(m?.declaring_object).toBe('SalesLineTypeBase');
    expect(m?.return_type).toBe('str');
  });
  it('reports the target itself as the declaring object for own methods', () => {
    expect(validateMethodSignature(db, 'SalesLineType', 'insert')?.declaring_object).toBe(
      'SalesLineType'
    );
  });
  it('honours expected parameter count on inherited methods', () => {
    expect(validateMethodSignature(db, 'SalesLineTypeDerived', 'baseOnly', 1)).not.toBeNull();
    expect(validateMethodSignature(db, 'SalesLineTypeDerived', 'baseOnly', 2)).toBeNull();
  });
  it('returns the access modifier and static flag of the resolved method', () => {
    const own = validateMethodSignature(db, 'SalesLineType', 'insert');
    expect(own?.access_modifier).toBe('public');
    expect(own?.is_static).toBe(0);

    const inherited = validateMethodSignature(db, 'SalesLineTypeDerived', 'baseProtectedStatic');
    expect(inherited?.access_modifier).toBe('protected');
    expect(inherited?.is_static).toBe(1);
  });
  it('terminates on cyclic inheritance chains', () => {    expect(validateMethodSignature(db, 'CycleA', 'nope')).toBeNull();
  });
});

describe('validateCoCTarget', () => {
  it('accepts an indexed class', () => {
    expect(validateCoCTarget(db, 'SalesLineType').ok).toBe(true);
  });
  it('rejects missing targets', () => {
    const res = validateCoCTarget(db, 'DoesNotExist');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not found');
  });
  it('rejects existing extension classes', () => {
    expect(validateCoCTarget(db, 'SalesLineType_Extension').ok).toBe(false);
  });
  it('does not treat a commented-out or textual ExtensionOf mention as an extension', () => {
    expect(validateCoCTarget(db, 'MentionsExtensionOf').ok).toBe(true);
  });
});

describe('validateTableFieldEdts', () => {
  it('accepts fields with known EDTs', () => {
    expect(validateTableFieldEdts(db, [{ name: 'MyField', edt: 'CustAccount' }]).ok).toBe(true);
  });
  it('rejects unknown EDTs', () => {
    const res = validateTableFieldEdts(db, [{ name: 'MyField', edt: 'GhostEdt' }]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('GhostEdt');
  });
  it('rejects blank EDT values', () => {
    const res = validateTableFieldEdts(db, [{ name: 'MyField', edt: '   ' }]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('must not be empty');
  });
  it('rejects invalid field names', () => {
    expect(validateTableFieldEdts(db, [{ name: '1Bad', edt: 'CustAccount' }]).ok).toBe(false);
  });
});

describe('validateNaming', () => {
  it('accepts valid identifiers', () => {
    expect(validateNaming('MyClass_1').ok).toBe(true);
    expect(validateNaming('_leading').ok).toBe(true);
  });
  it('rejects empty, invalid and reserved names', () => {
    expect(validateNaming('').ok).toBe(false);
    expect(validateNaming('1Bad').ok).toBe(false);
    expect(validateNaming('has space').ok).toBe(false);
    expect(validateNaming('class').ok).toBe(false);
    expect(validateNaming('a'.repeat(41)).ok).toBe(false);
  });
});
