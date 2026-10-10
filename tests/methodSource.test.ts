import { describe, it, expect } from 'vitest';
import { getMethodSource } from '../src/tools/codeQuality.js';
import { seedDb } from './helpers/toolHarness.js';

const xml = (methods: Record<string, string>) =>
  `<AxClass><Name>Calc</Name><SourceCode><Declaration><![CDATA[class Calc\n{\n}]]></Declaration><Methods>` +
  Object.entries(methods)
    .map(([n, body]) => `<Method><Name>${n}</Name><Source><![CDATA[${body}]]></Source></Method>`)
    .join('') +
  `</Methods></SourceCode></AxClass>`;

describe('get_method_source', () => {
  const db = seedDb([{ type: 'Class', name: 'Calc', raw_xml: xml({ add: 'public int add(int a, int b)\n{\n    return a + b;\n}', big: 'x'.repeat(2000) }) }]);

  it('returns a method body case-insensitively, and the class declaration', async () => {
    const res = JSON.parse((await getMethodSource(db, { objectName: 'calc', methodName: 'ADD' })).content[0].text);
    expect(res.object).toEqual({ type: 'Class', name: 'Calc' });
    expect(res.sources[0].source).toContain('return a + b;');
    const decl = JSON.parse((await getMethodSource(db, { objectName: 'Calc', methodName: 'classDeclaration' })).content[0].text);
    expect(decl.sources[0].source).toContain('class Calc');
  });

  it('truncates to maxChars and reports it', async () => {
    const res = JSON.parse((await getMethodSource(db, { objectName: 'Calc', methodName: 'big', maxChars: 500 })).content[0].text);
    expect(res.truncated).toBe(true);
    expect(res.sources[0].source).toHaveLength(500);
    expect(res.sources[0].totalChars).toBe(2000);
  });

  it('lists available methods for an unknown method and suggests names for an unknown object', async () => {
    const missing = await getMethodSource(db, { objectName: 'Calc', methodName: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Methods with source: classDeclaration, add, big');
    const ghost = await getMethodSource(db, { objectName: 'Calcc', methodName: 'add', objectType: 'Class' });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0].text).toContain('Did you mean: Calc');
  });
});
