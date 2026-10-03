import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadObjectXml, loadObjectXmlSync, setSourceFileReads } from '../src/indexer/sourceFiles.js';

describe('loadObjectXml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-source-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-source-outside-'));
  const xmlFile = path.join(dir, 'MyClass.xml');
  const secretFile = path.join(dir, 'secrets.env');
  const outsideXml = path.join(outsideDir, 'Secret.xml');
  fs.writeFileSync(xmlFile, '<AxClass/>');
  fs.writeFileSync(secretFile, 'MCP_API_KEYS=alice=secret');
  fs.writeFileSync(outsideXml, '<Secret/>');

  beforeEach(() => setSourceFileReads(true, dir));
  afterEach(() => setSourceFileReads(false));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('prefers stored XML and falls back to the indexed .xml file', async () => {
    expect(await loadObjectXml({ raw_xml: '<Stored/>', file_path: xmlFile })).toBe('<Stored/>');
    expect(await loadObjectXml({ raw_xml: '', file_path: xmlFile })).toBe('');
    expect(await loadObjectXml({ raw_xml: null, file_path: xmlFile })).toBe('<AxClass/>');
    expect(loadObjectXmlSync({ raw_xml: null, file_path: xmlFile })).toBe('<AxClass/>');
  });

  it('never reads a file that is not XML', async () => {
    expect(await loadObjectXml({ raw_xml: null, file_path: secretFile })).toBeNull();
    expect(loadObjectXmlSync({ raw_xml: null, file_path: secretFile })).toBe('');
  });

  it('never reads XML outside the configured packages tree', async () => {
    expect(await loadObjectXml({ raw_xml: null, file_path: outsideXml })).toBeNull();
    expect(loadObjectXmlSync({ raw_xml: null, file_path: outsideXml })).toBe('');
  });

  it('reads nothing from disk once source reads are turned off', async () => {
    setSourceFileReads(false);
    expect(await loadObjectXml({ raw_xml: null, file_path: xmlFile })).toBeNull();
    expect(loadObjectXmlSync({ raw_xml: null, file_path: xmlFile })).toBe('');
    expect(await loadObjectXml({ raw_xml: '<Stored/>', file_path: xmlFile })).toBe('<Stored/>');
  });
});
