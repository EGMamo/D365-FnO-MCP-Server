/**
 * Barrel for the transport implementations. Concrete logic lives in
 * `src/server/httpTransport.ts` and `src/server/stdioTransport.ts`.
 */
export { createHttpApp, startHttpServer } from './server/httpTransport.js';
export type { HttpTransportOptions, ServerFactory } from './server/httpTransport.js';
export { startStdioServer } from './server/stdioTransport.js';
export type { StdioTransportOptions } from './server/stdioTransport.js';
