import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createBrotliDecompress, createGunzip, createGzip } from 'node:zlib';

/**
 * Transfer encodings for a packaged index. The names match HTTP content
 * codings so manifests and upload requests share one vocabulary.
 */
export const INDEX_ENCODINGS = ['gzip', 'br', 'identity'] as const;
export type IndexEncoding = (typeof INDEX_ENCODINGS)[number];

export const COMPRESSION_LEVELS = ['fastest', 'balanced', 'smallest'] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

/** File name suffix of a packaged index per encoding. */
export const ENCODING_SUFFIX: Record<IndexEncoding, string> = { gzip: '.gz', br: '.br', identity: '' };

/**
 * gzip 1/6/9. Brotli stops at quality 9: 10 and 11 are an order of magnitude
 * slower on multi-GB databases for a few percent less output.
 */
const GZIP_LEVEL: Record<CompressionLevel, number> = { fastest: 1, balanced: 6, smallest: 9 };
const BROTLI_QUALITY: Record<CompressionLevel, number> = { fastest: 1, balanced: 5, smallest: 9 };

/** Accepts the CLI spellings (`brotli`, `none`) as well as the encoding names. */
export function parseEncoding(value: string): IndexEncoding {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'brotli') return 'br';
  if (normalized === 'none') return 'identity';
  if ((INDEX_ENCODINGS as readonly string[]).includes(normalized)) return normalized as IndexEncoding;
  throw new Error(`Unknown compression '${value}'; use gzip, brotli or none.`);
}

export function parseCompressionLevel(value: string): CompressionLevel {
  const normalized = value.trim().toLowerCase();
  if ((COMPRESSION_LEVELS as readonly string[]).includes(normalized)) return normalized as CompressionLevel;
  throw new Error(`Unknown compression level '${value}'; use fastest, balanced or smallest.`);
}

export function createCompressor(encoding: IndexEncoding, level: CompressionLevel, sizeHint?: number): Duplex {
  switch (encoding) {
    case 'gzip':
      return createGzip({ level: GZIP_LEVEL[level] });
    case 'br':
      return createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY[level],
          [constants.BROTLI_PARAM_LGWIN]: 24,
          ...(sizeHint ? { [constants.BROTLI_PARAM_SIZE_HINT]: Math.min(sizeHint, 2 ** 31 - 1) } : {}),
        },
      });
    case 'identity':
      return new PassThrough();
  }
}

export function createDecompressor(encoding: IndexEncoding): Duplex {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'br':
      return createBrotliDecompress();
    case 'identity':
      return new PassThrough();
  }
}

/** Pass-through stream that hashes and counts what flows through it. */
export class HashingTap extends Transform {
  private readonly hash = createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null, data?: Buffer) => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

export interface CompressedFile {
  encoding: IndexEncoding;
  /** SHA-256 and size of the encoded (transferred) bytes. */
  sha256: string;
  bytes: number;
  /** SHA-256 and size of the database itself. */
  rawSha256: string;
  rawBytes: number;
}

/**
 * Pass-through stream that fails once more than `limit` bytes flow through it.
 * Guards decoders against compression bombs: a declared or published size is
 * known up front, so nothing past it needs to reach the disk.
 */
export function byteLimit(limit: number, onExceeded: () => Error): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(onExceeded());
      else callback(null, chunk);
    },
  });
}

/** Encodes `source` into `destination`, hashing both sides in the same pass. */
export async function compressFile(
  source: string,
  destination: string,
  encoding: IndexEncoding,
  level: CompressionLevel = 'balanced',
  onProgress?: (rawBytesRead: number) => void,
  signal?: AbortSignal
): Promise<CompressedFile> {
  const rawTap = new HashingTap();
  const encodedTap = new HashingTap();
  if (onProgress) rawTap.on('data', () => onProgress(rawTap.bytes));
  const sizeHint = fs.statSync(source).size;
  await pipeline(
    fs.createReadStream(source, { highWaterMark: 1024 * 1024 }),
    rawTap,
    createCompressor(encoding, level, sizeHint),
    encodedTap,
    fs.createWriteStream(destination),
    { signal }
  );
  return {
    encoding,
    sha256: encodedTap.digest(),
    bytes: encodedTap.bytes,
    rawSha256: rawTap.digest(),
    rawBytes: rawTap.bytes,
  };
}

/** SHA-256 and size of a file on disk. */
export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}
