type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * Structured logger. Always writes to stderr so that stdout stays reserved for
 * JSON-RPC framing when the server runs under the stdio transport.
 */
function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    scope: 'D365-MCP',
    message,
    ...(meta ?? {}),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('DEBUG', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('INFO', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('WARN', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('ERROR', message, meta),
  fatal: (message: string, meta?: Record<string, unknown>) => emit('FATAL', message, meta),
};
