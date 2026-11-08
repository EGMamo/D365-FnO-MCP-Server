import { getMeta, META_KEYS, type Database } from '../indexer/db.js';
import { countIndexRows, readIndexApplicationVersion, readIndexSchemaVersion } from '../indexer/buildIndex.js';
import { logger } from '../utils/logger.js';

/**
 * What `GET /status`, `get_index_stats` and the `x-d365-index-version` header say about a server. The facts about
 * an index come from the indexer; this module only shapes them and keeps them for a minute. It reads no
 * configuration of its own, so tests can use it without starting a server.
 */

/** What a bundle-backed server was activated from at startup: exactly these fields, never the bundle object itself. */
export interface ArtifactDescription {
  source: 'azure-blob' | 'local';
  bundleId: string;
  pointerRevision: number;
  createdAt: string;
  applicationVersion: string;
}

export interface IndexDescription {
  /** Four-part D365 application version, normalised, or null when unknown. */
  applicationVersion: string | null;
  /** Where the version came from (`packages-dir`, …), `configured` for the server's own setting, or null. */
  applicationVersionSource: string | null;
  builtAt: string | null;
  schemaVersion: number | null;
  objects: number;
  labels: number;
}

export interface SessionCounts {
  active: number;
  max: number;
  /** 0 when only the global cap applies. */
  maxPerKey: number;
}

export interface ServerStatus {
  status: 'ok' | 'starting';
  you: { keyName: string };
  server: {
    version: string;
    startedAt: string;
    uptimeSeconds: number;
    /** Where the developer keys live and when they were last read; null without a key registry. No names, no counts. */
    keyRegistry: { kind: 'file' | 'azure-blob'; loadedAt: string | null } | null;
  };
  /** Null while the server is starting. */
  index: IndexDescription | null;
  /** Null while starting and on a server that was not started from a bundle. */
  artifact: ArtifactDescription | null;
  sessions: SessionCounts;
}

/** What the HTTP transport asks a server for. Both calls are synchronous and `indexVersion` never throws. */
export interface StatusProvider {
  /** The normalised application version for the response header, or null when unknown or not ready. */
  indexVersion(): string | null;
  describe(input: { ready: boolean; keyName: string; sessions: SessionCounts }): ServerStatus;
}

/**
 * The bundle facts of a running server, copied field by field. A validated bundle also carries the absolute
 * directory it was staged in, so nothing is ever spread from it.
 */
export function describeArtifact(
  source: ArtifactDescription['source'],
  pointerRevision: number,
  manifest: { bundleId: string; createdAt: string; d365: { applicationVersion: string } }
): Readonly<ArtifactDescription> {
  return Object.freeze({
    source,
    bundleId: manifest.bundleId,
    pointerRevision,
    createdAt: manifest.createdAt,
    applicationVersion: manifest.d365.applicationVersion,
  });
}

/** What an index says about itself. `counts` come separately because they are the costly part and are cached. */
export function describeServedIndex(
  db: Database,
  counts: { objects: number; labels: number },
  configuredApplicationVersion?: string | null
): IndexDescription {
  const version = readIndexApplicationVersion(db, configuredApplicationVersion);
  return {
    applicationVersion: version.version,
    applicationVersionSource: version.source,
    builtAt: getMeta(db, META_KEYS.builtAt),
    schemaVersion: readIndexSchemaVersion(db),
    objects: counts.objects,
    labels: counts.labels,
  };
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export interface StatusProviderOptions {
  /** The server's own version, the one `/health` reports. */
  version: string;
  /** The open index, or null while the server is starting. */
  database: () => Database | null;
  /** The server's own application version setting, used when the index records none. */
  configuredApplicationVersion?: string | null;
  /** The bundle this process was activated from, or null. */
  artifact: () => ArtifactDescription | null;
  /** The key registry, or null (the default) when the server has none. */
  keyRegistry?: () => { kind: 'file' | 'azure-blob'; loadedAt: string | null } | null;
  /** Milliseconds since the epoch; replaceable for tests. */
  now?: () => number;
  /** Seconds since the process started; replaceable for tests. */
  uptimeSeconds?: () => number;
  /** How long a description of the index is kept (default 60 seconds). */
  cacheTtlMs?: number;
}

export function createStatusProvider(options: StatusProviderOptions): StatusProvider {
  const now = options.now ?? Date.now;
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const startedAt = new Date(now() - uptimeSeconds() * 1000).toISOString();

  // One entry for the whole description, so a document never pairs a new build time with old counts, and the
  // header, which is asked for on every authenticated request, costs no query.
  let cached: { db: Database; at: number; description: IndexDescription } | null = null;

  function indexDescription(): IndexDescription | null {
    const db = options.database();
    if (!db) return null;
    const at = now();
    // A clock that steps backwards must not keep an old entry alive.
    if (cached && cached.db === db && at - cached.at >= 0 && at - cached.at < ttlMs) return cached.description;
    const description = describeServedIndex(db, countIndexRows(db), options.configuredApplicationVersion);
    cached = { db, at, description };
    return description;
  }

  return {
    indexVersion() {
      try {
        return indexDescription()?.applicationVersion ?? null;
      } catch (error) {
        logger.debug('Index version unavailable for the response header', { error: String(error) });
        return null;
      }
    },
    describe({ ready, keyName, sessions }) {
      return {
        status: ready ? 'ok' : 'starting',
        you: { keyName },
        server: {
          version: options.version,
          startedAt,
          uptimeSeconds: Math.floor(uptimeSeconds()),
          keyRegistry: options.keyRegistry?.() ?? null,
        },
        index: ready ? indexDescription() : null,
        artifact: ready ? options.artifact() : null,
        sessions: { active: sessions.active, max: sessions.max, maxPerKey: sessions.maxPerKey },
      };
    },
  };
}
