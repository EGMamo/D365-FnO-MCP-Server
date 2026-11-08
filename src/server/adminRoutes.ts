import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';
import { renderAdminPage } from './adminPage.js';
import { KEY_NAME_PATTERN, digestKey, type ApiKeyEntry } from './apiKeys.js';
import { KeyRegistryError, type KeyRegistry } from './keyRegistry.js';

/**
 * Key administration over HTTP, mounted at `/admin` ahead of API-key auth: the page, and `GET/POST /admin/api/keys`
 * plus `DELETE /admin/api/keys/:name`, all behind the admin key (`X-Admin-Key`). No Microsoft sign-in: the admin
 * key is the only credential. Operator build only.
 */

export interface KeyAdminOptions {
  registry: KeyRegistry;
  /** The fixed keys from MCP_API_KEYS / MCP_API_KEY: listed, never revocable here. */
  staticKeys: readonly ApiKeyEntry[];
  /** As the transport's TRUST_PROXY_HOPS: decides whether X-Forwarded-For and -Proto are believed. */
  trustProxyHops: number;
  /** Admin requests per window and address (default 20 a minute). */
  rateLimit?: { max: number; windowMs: number };
  /** Accept plain HTTP from this machine itself (default true); tests turn it off to see the HTTPS rule. */
  allowLoopback?: boolean;
}

export const ADMIN_KEY_REQUIRED = 'Admin key required: send it as X-Admin-Key.';
export const DEVELOPER_KEY_REFUSED = 'This is a developer key; key management needs the admin key.';
export const HTTPS_ONLY = 'Key management is served over HTTPS only.';
export const NO_ADMIN_YET = 'No admin key yet: run keys reset-admin.';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function digestsEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function createKeyAdminRouter(options: KeyAdminOptions): Router {
  const { registry, staticKeys } = options;
  const router = express.Router();
  const staticDigests = new Set(staticKeys.map((entry) => digestKey(entry.key)));
  const staticNames = new Set(staticKeys.map((entry) => entry.name));
  const clientIp = (req: Request): string =>
    options.trustProxyHops > 0 ? (req.ip ?? 'unknown') : (req.socket.remoteAddress ?? 'unknown');

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  router.use(
    rateLimit({
      windowMs: options.rateLimit?.windowMs ?? 60_000,
      max: options.rateLimit?.max ?? 20,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => clientIp(req),
      handler: (req, res) => {
        logger.warn('Key administration rate limit exceeded', { ip: clientIp(req) });
        res.status(429).json({ error: 'Too many key administration requests from this address; retry in a minute.' });
      },
    })
  );

  // Over HTTPS, as the proxy in front reports it when one is trusted, or from this machine itself.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const secure = options.trustProxyHops > 0 ? req.protocol === 'https' : req.secure;
    if (secure || ((options.allowLoopback ?? true) && LOOPBACK.has(req.socket.remoteAddress ?? ''))) return next();
    res.status(403).json({ error: HTTPS_ONLY });
  });

  router.get('/', (_req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    res
      .set(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
          "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
      )
      .type('html')
      .send(renderAdminPage(nonce));
  });

  const api = express.Router();
  api.use(express.json({ limit: '1kb' }));
  api.use((req: Request, res: Response, next: NextFunction) => {
    const adminDigest = registry.adminDigest();
    if (adminDigest === null) {
      res.status(503).json({ error: NO_ADMIN_YET });
      return;
    }
    const header = req.headers['x-admin-key'];
    const presented = typeof header === 'string' ? header.trim() : '';
    const developerKey = req.headers['x-api-key'] ?? req.headers.authorization;
    if (!presented) {
      logger.warn('Key administration refused', { ip: clientIp(req), reason: developerKey ? 'developer credential only' : 'no admin key' });
      res.status(developerKey ? 403 : 401).json({ error: developerKey ? DEVELOPER_KEY_REFUSED : ADMIN_KEY_REQUIRED });
      return;
    }
    const digest = digestKey(presented);
    if (registry.developerKeys().has(digest) || staticDigests.has(digest)) {
      logger.warn('Key administration refused', { ip: clientIp(req), reason: 'developer key' });
      res.status(403).json({ error: DEVELOPER_KEY_REFUSED });
      return;
    }
    if (!digestsEqual(digest, adminDigest)) {
      logger.warn('Key administration refused', { ip: clientIp(req), reason: 'wrong admin key' });
      res.status(401).json({ error: ADMIN_KEY_REQUIRED });
      return;
    }
    next();
  });

  api.get('/keys', (_req: Request, res: Response) => {
    res.json({
      keys: [
        ...registry.list().map((entry) => ({ ...entry, source: 'registry' as const })),
        ...staticKeys.map((entry) => ({ name: entry.name, createdAt: null, source: 'settings' as const })),
      ],
    });
  });

  api.post('/keys', async (req: Request, res: Response) => {
    const name = typeof (req.body as { name?: unknown } | undefined)?.name === 'string' ? ((req.body as { name: string }).name).trim() : '';
    if (!KEY_NAME_PATTERN.test(name)) {
      res.status(400).json({ error: "A key name must be 1-64 characters of letters, digits, '.', '_', '@' or '-'." });
      return;
    }
    if (staticNames.has(name)) {
      res.status(409).json({ error: `${name} is a key managed outside the server (MCP_API_KEYS); choose another name.` });
      return;
    }
    try {
      const key = await registry.createKey(name);
      logger.info('Key administration', { action: 'create', name, ip: clientIp(req) });
      res.status(201).json({ name, key });
    } catch (error) {
      if (!(error instanceof KeyRegistryError)) throw error;
      res.status(409).json({ error: error.message });
    }
  });

  api.delete('/keys/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (staticNames.has(name)) {
      res.status(409).json({ error: `${name} is managed outside the server (MCP_API_KEYS) and cannot be revoked here.` });
      return;
    }
    try {
      if (!(await registry.revokeKey(name))) {
        res.status(404).json({ error: `There is no key named ${name}.` });
        return;
      }
    } catch (error) {
      if (!(error instanceof KeyRegistryError)) throw error;
      res.status(409).json({ error: error.message });
      return;
    }
    logger.info('Key administration', { action: 'revoke', name, ip: clientIp(req) });
    res.status(204).end();
  });

  // Anything else under the API, and body problems, as JSON errors that echo nothing.
  api.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found.' });
  });
  api.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'The request body is larger than 1 KiB.' });
      return;
    }
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      res.status(400).json({ error: 'The request body is not valid JSON.' });
      return;
    }
    logger.error('Key administration failed', { error: err?.message });
    res.status(500).json({ error: 'Key administration failed; see the server log.' });
  });

  router.use('/api', api);
  return router;
}
