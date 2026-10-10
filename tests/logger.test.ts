import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    fn();
  } finally {
    write.mockRestore();
  }
  return lines.map((line) => (JSON.parse(line) as { level: string }).level);
}

describe('logger', () => {
  afterEach(() => vi.unstubAllEnvs());

  function logEveryLevel() {
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
  }

  it('writes INFO and above when MCP_LOG_LEVEL is unset', () => {
    vi.stubEnv('MCP_LOG_LEVEL', undefined);
    expect(capture(logEveryLevel)).toEqual(['INFO', 'WARN', 'ERROR']);
  });

  it('writes DEBUG when MCP_LOG_LEVEL asks for it', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'debug');
    expect(capture(logEveryLevel)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('drops lines below MCP_LOG_LEVEL, case-insensitively', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'warn');
    expect(capture(logEveryLevel)).toEqual(['WARN', 'ERROR']);
  });

  it('writes nothing when MCP_LOG_LEVEL is SILENT', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'SILENT');
    expect(capture(logEveryLevel)).toEqual([]);
  });

  it('ignores an unknown MCP_LOG_LEVEL', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'verbose');
    expect(capture(logEveryLevel)).toEqual(['INFO', 'WARN', 'ERROR']);
  });

  it('keeps the fixed fields when meta reuses their names', () => {
    vi.stubEnv('MCP_LOG_LEVEL', undefined);
    expect(capture(() => logger.warn('w', { level: 'DEBUG', ts: 'x' }))).toEqual(['WARN']);
  });
});
