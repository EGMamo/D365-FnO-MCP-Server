type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

const LEVELS: Record<LogLevel | 'SILENT', number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4, SILENT: 5 };

/** Lowest level written, from MCP_LOG_LEVEL (read on every call so tests can change it). Defaults to DEBUG. */
function threshold(): number {
  const configured = process.env.MCP_LOG_LEVEL?.trim().toUpperCase();
  return configured && configured in LEVELS ? LEVELS[configured as keyof typeof LEVELS] : LEVELS.DEBUG;
}

/**
 * Structured logger. Always writes to stderr so that stdout stays reserved for
 * JSON-RPC framing when the server runs under the stdio transport.
 */
function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return;
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
