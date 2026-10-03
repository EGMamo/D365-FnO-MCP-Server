import path from 'node:path';

/**
 * D365 F&O application versions and the session-start warning derived from
 * them.
 *
 * The server answers from one indexed SDK snapshot. A client whose own
 * `PackagesLocalDirectory` is a different build asks questions about metadata
 * that may not exist on its side, so every session is told which version it is
 * talking to, and is warned when the two disagree.
 *
 * Nothing here reads the filesystem or the database: it is pure so the drift
 * rules can be tested directly.
 */

/** A four-part D365 application version, e.g. `10.0.2645.136`. */
export interface AppVersion {
  major: number;
  minor: number;
  build: number;
  revision: number;
  /** The normalised `major.minor.build.revision` text. */
  text: string;
}

const APP_VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/**
 * Parses a four-part application version. Anything else — a three-part
 * marketing version such as `10.0.39`, a label, or free text — returns null
 * rather than being coerced, because a wrong comparison is worse than none.
 */
export function parseAppVersion(value: string | null | undefined): AppVersion | null {
  if (typeof value !== 'string') return null;
  const match = APP_VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const [major, minor, build, revision] = match.slice(1, 5).map(Number);
  return { major, minor, build, revision, text: `${major}.${minor}.${build}.${revision}` };
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.build - b.build ||
    a.revision - b.revision
  );
}

/**
 * Locates the version in a UDE packages path. The SDK is extracted to
 * `%LOCALAPPDATA%\Microsoft\Dynamics365\<appVersion>\PackagesLocalDirectory`,
 * so the version is an ancestor directory name. Classic AOS layouts
 * (`K:\AosService\PackagesLocalDirectory`) have none and return null.
 */
export function detectAppVersionFromPackagesDir(packagesDir: string | null | undefined): string | null {
  if (typeof packagesDir !== 'string' || packagesDir.trim().length === 0) return null;
  let current = path.resolve(packagesDir.trim());
  // Only the directory itself and its ancestors are considered, nearest first.
  for (;;) {
    const parsed = parseAppVersion(path.basename(current));
    if (parsed) return parsed.text;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * How a client's SDK relates to the indexed one.
 *
 * `older-build` is the only genuinely risky case: a different release wave can
 * add or remove objects. `older-revision` is a hotfix delta that rarely changes
 * metadata shape, and warning at the same strength would make the message
 * routine enough to ignore.
 */
export type SdkDriftCode =
  | 'match'
  | 'older-build'
  | 'older-revision'
  | 'client-newer'
  | 'client-unknown'
  | 'index-unknown';

export type SdkDriftSeverity = 'none' | 'info' | 'notice' | 'warning';

export interface SdkDrift {
  code: SdkDriftCode;
  severity: SdkDriftSeverity;
  /** Normalised index version, or null when the index does not record one. */
  indexVersion: string | null;
  /** Normalised client version, or null when it was not declared or not parseable. */
  clientVersion: string | null;
  /** The client's declaration as received, kept when it could not be parsed. */
  declaredClientVersion: string | null;
}

/**
 * Classifies a client's declared SDK version against the indexed one.
 * Unknown on either side is reported as such and never guessed.
 */
export function classifySdkDrift(
  declaredClientVersion: string | null | undefined,
  indexVersion: string | null | undefined
): SdkDrift {
  const index = parseAppVersion(indexVersion);
  const client = parseAppVersion(declaredClientVersion);
  const declared = typeof declaredClientVersion === 'string' && declaredClientVersion.trim().length > 0
    ? declaredClientVersion.trim()
    : null;
  const base = {
    indexVersion: index?.text ?? null,
    clientVersion: client?.text ?? null,
    declaredClientVersion: declared,
  };

  if (!index) return { ...base, code: 'index-unknown', severity: 'info' };
  if (!client) return { ...base, code: 'client-unknown', severity: 'info' };

  const ordering = compareAppVersions(client, index);
  if (ordering === 0) return { ...base, code: 'match', severity: 'none' };
  if (ordering > 0) return { ...base, code: 'client-newer', severity: 'notice' };

  const sameBuild =
    client.major === index.major && client.minor === index.minor && client.build === index.build;
  return sameBuild
    ? { ...base, code: 'older-revision', severity: 'notice' }
    : { ...base, code: 'older-build', severity: 'warning' };
}

export interface SessionInstructionInput {
  /** Application version the served index describes. */
  indexVersion: string | null;
  /** Version the client declared for its own PackagesLocalDirectory. */
  clientVersion?: string | null;
  /** When the index was built, for provenance. */
  builtAt?: string | null;
}

export interface SessionInstructions {
  drift: SdkDrift;
  /** Instructions handed to the client at `initialize`. */
  text: string;
}

function describeIndex(indexVersion: string | null, builtAt: string | null | undefined): string {
  const built = typeof builtAt === 'string' && builtAt.length > 0 ? ` (indexed ${builtAt})` : '';
  return indexVersion
    ? `This server answers from a D365 Finance and Operations metadata index built from application version ${indexVersion}${built}.`
    : `This server answers from a D365 Finance and Operations metadata index that does not record its application version${built}.`;
}

/**
 * Builds the text sent as the server's `instructions` at session start.
 * A matching or undeclared version still states the indexed version, so the
 * model and the user always know which SDK the answers describe.
 */
export function buildSessionInstructions(input: SessionInstructionInput): SessionInstructions {
  const drift = classifySdkDrift(input.clientVersion, input.indexVersion);
  const lines = [describeIndex(drift.indexVersion, input.builtAt)];

  switch (drift.code) {
    case 'match':
      lines.push(
        `Your declared SDK version ${drift.clientVersion} matches the index. Metadata answers apply to your environment.`
      );
      break;
    case 'older-build':
      lines.push(
        `WARNING: you declared SDK version ${drift.clientVersion}, an older release than the indexed ${drift.indexVersion}.`,
        'Objects, fields, methods and labels returned by these tools may not exist in your environment. Verify an element exists locally before generating code against it, and state this mismatch when answers depend on it.'
      );
      break;
    case 'older-revision':
      lines.push(
        `NOTICE: you declared SDK version ${drift.clientVersion}; the index is the newer hotfix ${drift.indexVersion}. Differences are usually small, but recently added elements may be missing locally.`
      );
      break;
    case 'client-newer':
      lines.push(
        `NOTICE: you declared SDK version ${drift.clientVersion}, which is newer than the indexed ${drift.indexVersion}. Elements added after the indexed version are not covered here.`
      );
      break;
    case 'client-unknown':
      lines.push(
        drift.declaredClientVersion
          ? `Your SDK version "${drift.declaredClientVersion}" could not be read as a four-part version, so no comparison was made. Confirm your local PackagesLocalDirectory matches ${drift.indexVersion}.`
          : `You did not declare your SDK version. Send it as the ${CLIENT_SDK_VERSION_HEADER} header to be warned about mismatches. Until then, confirm your local PackagesLocalDirectory matches ${drift.indexVersion}.`
      );
      break;
    case 'index-unknown':
      lines.push(
        'The served index does not record which application version it was built from, so no version comparison is possible. Treat metadata answers as unverified against your environment.'
      );
      break;
  }

  return { drift, text: lines.join('\n\n') };
}

/** Header a client sends to declare its local PackagesLocalDirectory version. */
export const CLIENT_SDK_VERSION_HEADER = 'x-d365-client-sdk-version';

/** Header the server echoes with the application version its index describes. */
export const INDEX_VERSION_HEADER = 'x-d365-index-version';

/**
 * Reads the declared client version from request headers. A repeated header
 * is ambiguous, so only a single value is accepted.
 */
export function readDeclaredClientVersion(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const raw = headers[CLIENT_SDK_VERSION_HEADER];
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
}
