/**
 * STORAGE ADAPTERS
 *
 * P2 (no ambient authority) is why this interface is deliberately dumb: it
 * takes an opaque key and moves bytes. It has no idea what an org is, cannot
 * be asked "who may read this", and is never consulted during an authorization
 * decision. If the adapter could answer access questions there would be two
 * authorization paths, and the second one is always the one that leaks.
 *
 * Corollary: object keys are NOT secrets and are not treated as such anywhere.
 *
 * -----------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY
 * -----------------------------------------------------------------------------
 *
 * 1. `provider` is now part of the interface.
 *
 *    `file.storage_provider` was written as the literal `'memory'` in
 *    `Filelayer.upload()`, regardless of which adapter was configured. Against
 *    `CREATE UNIQUE INDEX file_storage_key_idx ON file (storage_provider,
 *    storage_key)` that means a production database records every object as
 *    living in an in-memory store, and the one column that says WHERE the bytes
 *    are is wrong for every row. An adapter must therefore be able to name
 *    itself, and the name must come from the adapter rather than from the call
 *    site.
 *
 * 2. Everything is streaming-capable.
 *
 *    `put()` took a `Uint8Array` and delivery returned one. That is a permanent
 *    tax on the heap: a 2 GB upload was 2 GB of resident memory in the API
 *    process, twice (once in the adapter, once in the response). `put()` now
 *    accepts a `ReadableStream` and uses S3 multipart above a part threshold;
 *    `stream()` returns a byte stream plus the metadata a correct HTTP response
 *    needs, and supports ranged reads.
 *
 * 3. `head()` exists.
 *
 *    A `stat()` that has to download the object to learn its size is not a
 *    stat.
 *
 * 4. `presignGet()` is OPTIONAL, and its optionality is the point.
 *
 *    It is the only capability the redirect delivery mode needs, and an adapter
 *    that cannot mint a presigned URL simply does not offer redirect delivery
 *    (`MemoryStorage` does not). Nothing else in the system may call it:
 *    a presigned URL is authority that outlives the decision that produced it,
 *    which is exactly the property P4 exists to deny, so it is reachable only
 *    through the explicitly-acknowledged redirect mode in `delivery.ts`.
 *
 * 5. `list()` is OPTIONAL and exists for exactly one caller: orphan collection.
 *
 *    The storage write is not transactional (see `db.ts`). Bytes are written
 *    before the metadata transaction commits, so a crash in between leaves an
 *    object with no `file` row. That is a garbage-collection problem, not a
 *    correctness one -- an orphan is unreachable, because every read path starts
 *    from a `file` row -- but it is still our problem. `list()` is what makes it
 *    collectable.
 */

import { createHash, createHmac } from 'node:crypto';

// -----------------------------------------------------------------------------
// The interface
// -----------------------------------------------------------------------------

/** Bytes, or a stream of bytes. Large uploads must use the second form. */
export type PutBody = Uint8Array | ReadableStream<Uint8Array>;

export interface StoragePutOptions {
  /** Total length when known. Lets a small streaming put skip multipart. */
  contentLength?: number;
}

export interface StoragePutResult {
  /** Bytes actually written. Authoritative for `file.size_bytes`. */
  bytes: number;
  etag: string | null;
}

export interface ByteRange {
  start: number;
  /** Inclusive, per HTTP. Omit for "to the end". */
  end?: number;
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export interface ObjectStream {
  body: ReadableStream<Uint8Array>;
  /** Bytes in THIS response (the range length for a ranged read). */
  size: number | null;
  contentType: string | null;
  etag: string | null;
  /** Present only when the store honoured a range request. */
  range?: { start: number; end: number; total: number };
}

export interface ListEntry {
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface PresignOptions {
  /** Seconds. The adapter clamps; the DELIVERY layer clamps harder. */
  expiresInSeconds: number;
  /** Forced onto the response by the object store, so the store cannot be
   * tricked into serving our bytes with an attacker-chosen content type. */
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface StorageAdapter {
  /**
   * The value written to `file.storage_provider`. It participates in a UNIQUE
   * index with the key, so it is part of an object's identity: change it for an
   * existing deployment and every existing row points at the wrong store.
   *
   * Conventional values: 'memory', 's3', 'r2', 'gcs'.
   */
  readonly provider: string;

  put(key: string, body: PutBody, contentType: string, opts?: StoragePutOptions): Promise<StoragePutResult>;
  /** Buffered read. Only for callers that genuinely want the whole object. */
  get(key: string): Promise<Uint8Array | null>;
  stream(key: string, opts?: { range?: ByteRange }): Promise<ObjectStream | null>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;

  /** Optional. Present => this adapter can support redirect delivery. */
  presignGet?(key: string, opts: PresignOptions): Promise<string>;
  /** Optional. Present => orphan collection can run against this adapter. */
  list?(
    prefix: string,
    opts?: { limit?: number; cursor?: string | null },
  ): Promise<{ entries: ListEntry[]; cursor: string | null }>;
}

/** Narrowing helpers, so callers do not hand-roll `typeof x.presignGet`. */
export function canPresign(
  s: StorageAdapter,
): s is StorageAdapter & Required<Pick<StorageAdapter, 'presignGet'>> {
  return typeof s.presignGet === 'function';
}

export function canList(
  s: StorageAdapter,
): s is StorageAdapter & Required<Pick<StorageAdapter, 'list'>> {
  return typeof s.list === 'function';
}

// -----------------------------------------------------------------------------
// Stream helpers
// -----------------------------------------------------------------------------

/** Collect a byte stream, refusing to exceed `limit`. */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  limit = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel('limit exceeded').catch(() => {});
        throw new Error(`object exceeds the ${limit}-byte buffered read limit; use stream()`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function bytesToStream(body: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

// -----------------------------------------------------------------------------
// In-memory adapter (tests, local dev)
// -----------------------------------------------------------------------------

export class MemoryStorage implements StorageAdapter {
  readonly provider = 'memory';

  private readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string; etag: string; lastModified: Date }
  >();

  async put(key: string, body: PutBody, contentType: string): Promise<StoragePutResult> {
    const bytes = body instanceof Uint8Array ? body : await collectStream(body);
    const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
    this.objects.set(key, { body: bytes, contentType, etag, lastModified: new Date() });
    return { bytes: bytes.byteLength, etag };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      size: o.body.byteLength,
      contentType: o.contentType,
      etag: o.etag,
      lastModified: o.lastModified,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async stream(key: string, opts: { range?: ByteRange } = {}): Promise<ObjectStream | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    const total = o.body.byteLength;
    if (opts.range) {
      const start = Math.max(0, opts.range.start);
      const end = Math.min(opts.range.end ?? total - 1, total - 1);
      if (start > end) return null;
      const slice = o.body.subarray(start, end + 1);
      return {
        body: bytesToStream(slice),
        size: slice.byteLength,
        contentType: o.contentType,
        etag: o.etag,
        range: { start, end, total },
      };
    }
    return { body: bytesToStream(o.body), size: total, contentType: o.contentType, etag: o.etag };
  }

  async list(
    prefix: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ entries: ListEntry[]; cursor: string | null }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    const after = opts.cursor ?? '';
    const all = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix) && k > after)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const page = all.slice(0, limit);
    return {
      entries: page.map(([k, v]) => ({
        key: k,
        size: v.body.byteLength,
        lastModified: v.lastModified,
      })),
      cursor: all.length > limit ? (page[page.length - 1]?.[0] ?? null) : null,
    };
  }

  /**
   * DELIBERATELY ABSENT: `presignGet`.
   *
   * There is no URL that reaches an in-process Map, so redirect delivery is
   * structurally unavailable here rather than fake. A test that wants to
   * exercise redirect delivery must run against something that can actually
   * mint one -- which is the point.
   */

  /** Test-only: lets a test assert that delete really removed the bytes. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

// -----------------------------------------------------------------------------
// S3 / R2 adapter
// -----------------------------------------------------------------------------
//
// Written against the raw REST API with SigV4 signed by node:crypto, so we do
// not take a dependency on the AWS SDK (which is ~15MB and would dominate our
// cold-start budget on Workers). R2 is S3-compatible; set `endpoint` to the
// account endpoint and `region` to 'auto'.
//
// TESTING STATUS. This is exercised on every `npm test` run against
// `test/local-s3.mjs`, a local S3-protocol server that RECOMPUTES EVERY SIGV4
// SIGNATURE (header-signed and presigned) and rejects a mismatch. That proves
// the wire format. It does not prove behaviour against real AWS or real R2; see
// `test/s3-live.test.ts` and the "unproven" list in the README for exactly what
// is still open.

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com, or a test server URL. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For STS / temporary credentials. Sent as `x-amz-security-token`. */
  sessionToken?: string;
  /**
   * What lands in `file.storage_provider`. Defaults to 'r2' for an R2 endpoint
   * and 's3' otherwise. It is part of an object's identity (see the UNIQUE
   * index), so pin it explicitly for anything long-lived.
   */
  provider?: string;
  /**
   * `https://host/<bucket>/<key>` (default, and what R2 uses) vs
   * `https://<bucket>.host/<key>`.
   */
  pathStyle?: boolean;
  /** Multipart part size. S3 requires >= 5 MiB for all but the last part. */
  partSizeBytes?: number;
  /** Hard ceiling on a presigned URL's lifetime, in seconds. */
  maxPresignSeconds?: number;
}

const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

export class S3Storage implements StorageAdapter {
  readonly provider: string;

  private readonly cfg: Required<
    Omit<S3Config, 'sessionToken' | 'provider'>
  > & { sessionToken?: string };

  constructor(cfg: S3Config) {
    for (const k of ['endpoint', 'bucket', 'region', 'accessKeyId', 'secretAccessKey'] as const) {
      if (typeof cfg[k] !== 'string' || cfg[k].length === 0) {
        throw new Error(`S3Storage: missing required config '${k}'`);
      }
    }
    const endpoint = cfg.endpoint.replace(/\/+$/, '');
    this.provider =
      cfg.provider ?? (/\.r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname) ? 'r2' : 's3');
    if (!/^[a-z0-9_-]{1,32}$/.test(this.provider)) {
      throw new Error(`S3Storage: implausible provider name ${JSON.stringify(this.provider)}`);
    }
    this.cfg = {
      endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      pathStyle: cfg.pathStyle ?? true,
      partSizeBytes: Math.max(MIN_PART_SIZE, cfg.partSizeBytes ?? DEFAULT_PART_SIZE),
      maxPresignSeconds: Math.max(1, Math.min(cfg.maxPresignSeconds ?? 3600, 7 * 24 * 3600)),
      ...(cfg.sessionToken !== undefined ? { sessionToken: cfg.sessionToken } : {}),
    };
  }

  // --- writes ---------------------------------------------------------------

  async put(
    key: string,
    body: PutBody,
    contentType: string,
    opts: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    if (body instanceof Uint8Array) return this.putBuffer(key, body, contentType);
    return this.putStream(key, body, contentType, opts);
  }

  private async putBuffer(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<StoragePutResult> {
    const res = await this.signedFetch({
      method: 'PUT',
      key,
      body,
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw await s3Error('put', res);
    await res.arrayBuffer(); // drain; undici leaks the connection otherwise
    return { bytes: body.byteLength, etag: res.headers.get('etag') };
  }

  /**
   * Streaming upload.
   *
   * The first `partSizeBytes` are buffered because we cannot know until we have
   * them whether this is a one-shot PUT or a multipart upload, and a one-shot
   * PUT needs `content-length` (and a payload hash) up front. Everything beyond
   * that is uploaded part by part and never all resident at once, so peak
   * memory is bounded by ONE part regardless of object size. That bound is the
   * entire point of this method.
   */
  private async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    opts: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const partSize = this.cfg.partSizeBytes;
    const reader = body.getReader();
    const first = await readAtLeast(reader, partSize);

    if (first.done) {
      // Whole object fits in one part.
      reader.releaseLock();
      return this.putBuffer(key, first.chunk, contentType);
    }
    if (opts.contentLength !== undefined && opts.contentLength <= partSize) {
      // Caller lied about the length; trust the bytes, not the claim.
    }

    const uploadId = await this.createMultipartUpload(key, contentType);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    let total = 0;
    let partNumber = 0;
    let pending: Uint8Array = first.chunk;

    try {
      for (;;) {
        partNumber += 1;
        parts.push({ partNumber, etag: await this.uploadPart(key, uploadId, partNumber, pending) });
        total += pending.byteLength;
        const next = await readAtLeast(reader, partSize);
        if (next.chunk.byteLength === 0 && next.done) break;
        pending = next.chunk;
        if (next.done) {
          partNumber += 1;
          parts.push({
            partNumber,
            etag: await this.uploadPart(key, uploadId, partNumber, pending),
          });
          total += pending.byteLength;
          break;
        }
      }
      const etag = await this.completeMultipartUpload(key, uploadId, parts);
      return { bytes: total, etag };
    } catch (err) {
      // An abandoned multipart upload is billable storage that no `file` row
      // points at -- the orphan problem, in its most expensive form. Abort is
      // best-effort because the original error is the one worth reporting.
      await this.abortMultipartUpload(key, uploadId).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
  }

  private async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.signedFetch({
      method: 'POST',
      key,
      query: { uploads: '' },
      body: new Uint8Array(),
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw await s3Error('createMultipartUpload', res);
    const xml = await res.text();
    const uploadId = xmlTag(xml, 'UploadId');
    if (!uploadId) throw new Error('storage createMultipartUpload: no UploadId in response');
    return uploadId;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<string> {
    const res = await this.signedFetch({
      method: 'PUT',
      key,
      query: { partNumber: String(partNumber), uploadId },
      body,
    });
    if (!res.ok) throw await s3Error('uploadPart', res);
    await res.arrayBuffer();
    const etag = res.headers.get('etag');
    if (!etag) throw new Error('storage uploadPart: no ETag in response');
    return etag;
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<string | null> {
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const res = await this.signedFetch({
      method: 'POST',
      key,
      query: { uploadId },
      body: new TextEncoder().encode(xml),
      headers: { 'content-type': 'application/xml' },
    });
    if (!res.ok) throw await s3Error('completeMultipartUpload', res);
    const text = await res.text();
    // S3 can return 200 with an <Error> body on this call specifically. Treating
    // that as success would report a successful upload of a broken object.
    if (/<Error>/.test(text)) {
      throw new Error(
        `storage completeMultipartUpload failed with 200 + Error body: ${xmlTag(text, 'Code') ?? text.slice(0, 200)}`,
      );
    }
    return xmlTag(text, 'ETag');
  }

  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const res = await this.signedFetch({ method: 'DELETE', key, query: { uploadId } });
    await res.arrayBuffer().catch(() => {});
  }

  // --- reads ----------------------------------------------------------------

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.signedFetch({ method: 'GET', key });
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    if (!res.ok) throw await s3Error('get', res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async head(key: string): Promise<ObjectHead | null> {
    const res = await this.signedFetch({ method: 'HEAD', key });
    // A HEAD has no body to read, but undici still wants the (empty) body
    // consumed before the socket goes back to the pool.
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage head failed: ${res.status}`);
    const len = res.headers.get('content-length');
    const lm = res.headers.get('last-modified');
    return {
      size: len === null ? 0 : Number(len),
      contentType: res.headers.get('content-type'),
      etag: res.headers.get('etag'),
      lastModified: lm ? new Date(lm) : null,
    };
  }

  async stream(key: string, opts: { range?: ByteRange } = {}): Promise<ObjectStream | null> {
    const headers: Record<string, string> = {};
    if (opts.range) {
      headers['range'] =
        opts.range.end === undefined
          ? `bytes=${opts.range.start}-`
          : `bytes=${opts.range.start}-${opts.range.end}`;
    }
    const res = await this.signedFetch({ method: 'GET', key, headers });
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    // 416 is "the range you asked for does not exist", which for our purposes is
    // the same answer as "no such bytes" rather than a 500.
    if (res.status === 416) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    if (!res.ok) throw await s3Error('stream', res);
    if (!res.body) throw new Error('storage stream: response had no body');

    const len = res.headers.get('content-length');
    const out: ObjectStream = {
      body: res.body as ReadableStream<Uint8Array>,
      size: len === null ? null : Number(len),
      contentType: res.headers.get('content-type'),
      etag: res.headers.get('etag'),
    };
    const cr = res.headers.get('content-range');
    const m = cr && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    if (m) out.range = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
    return out;
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedFetch({ method: 'DELETE', key });
    await res.arrayBuffer().catch(() => {});
    // S3 returns 204 for a delete of a key that never existed. 404 is here for
    // S3-compatible stores that disagree; either way "it is gone" is success.
    if (!res.ok && res.status !== 404) throw new Error(`storage delete failed: ${res.status}`);
  }

  async list(
    prefix: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ entries: ListEntry[]; cursor: string | null }> {
    const query: Record<string, string> = {
      'list-type': '2',
      prefix,
      'max-keys': String(Math.max(1, Math.min(opts.limit ?? 1000, 1000))),
    };
    if (opts.cursor) query['continuation-token'] = opts.cursor;
    const res = await this.signedFetch({ method: 'GET', key: '', query });
    if (!res.ok) throw await s3Error('list', res);
    const xml = await res.text();
    const entries: ListEntry[] = [];
    for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      const key = xmlTag(c, 'Key');
      if (key === null) continue;
      const lm = xmlTag(c, 'LastModified');
      entries.push({
        key: unescapeXml(key),
        size: Number(xmlTag(c, 'Size') ?? 0),
        lastModified: lm ? new Date(lm) : null,
      });
    }
    const truncated = xmlTag(xml, 'IsTruncated') === 'true';
    return { entries, cursor: truncated ? xmlTag(xml, 'NextContinuationToken') : null };
  }

  // --- presigning -----------------------------------------------------------

  /**
   * A query-string-signed GET URL.
   *
   * READ THE WARNING IN `delivery.ts` BEFORE CALLING THIS. The URL is bearer
   * authority that the object store will honour until it expires, and the
   * object store has never heard of a grant, a revocation or an org. That is
   * why it is not reachable from any ordinary delivery path.
   *
   * `response-content-type` and `response-content-disposition` are signed into
   * the URL, so the object store -- not the client -- decides what the bytes are
   * served as. Without them a redirect would drop the `nosniff`/`attachment`
   * protections that `deliveryHeaders()` exists to guarantee.
   */
  async presignGet(key: string, opts: PresignOptions): Promise<string> {
    const expires = Math.max(1, Math.min(Math.floor(opts.expiresInSeconds), this.cfg.maxPresignSeconds));
    const now = new Date();
    const amzDate = amzDateOf(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const { url, canonicalUri } = this.objectUrl(key);

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
    if (this.cfg.sessionToken) query['X-Amz-Security-Token'] = this.cfg.sessionToken;
    if (opts.responseContentType) query['response-content-type'] = opts.responseContentType;
    if (opts.responseContentDisposition) {
      query['response-content-disposition'] = opts.responseContentDisposition;
    }

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQueryString(query),
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const signature = this.sign(dateStamp, amzDate, scope, canonicalRequest);
    query['X-Amz-Signature'] = signature;
    return `${url.origin}${canonicalUri}?${canonicalQueryString(query)}`;
  }

  // --- signing --------------------------------------------------------------

  /**
   * Path-style: `https://host/<bucket>/<key>`. Virtual-hosted:
   * `https://<bucket>.host/<key>`.
   *
   * The canonical URI is built by RFC-3986-encoding each SEGMENT and is carried
   * separately from `URL.pathname`, because `new URL()` normalises `.`/`..`
   * segments and re-encodes some characters. Signing one string and sending
   * another is the classic SigV4 bug and produces a 403 that looks like a
   * credentials problem.
   */
  private objectUrl(key: string): { url: URL; canonicalUri: string } {
    const base = new URL(this.cfg.endpoint);
    const segments = key === '' ? [] : key.split('/');
    let host = base.host;
    let path: string;
    if (this.cfg.pathStyle) {
      path = '/' + [this.cfg.bucket, ...segments].map(rfc3986).join('/');
    } else {
      host = `${this.cfg.bucket}.${base.host}`;
      path = '/' + segments.map(rfc3986).join('/');
    }
    const url = new URL(`${base.protocol}//${host}${path}`);
    return { url, canonicalUri: path };
  }

  private sign(dateStamp: string, _amzDate: string, scope: string, canonicalRequest: string): string {
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      _amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');
    let k: Buffer = Buffer.from(`AWS4${this.cfg.secretAccessKey}`, 'utf8');
    for (const part of [dateStamp, this.cfg.region, 's3', 'aws4_request']) {
      k = createHmac('sha256', k).update(part, 'utf8').digest();
    }
    return createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  }

  private async signedFetch(req: {
    method: string;
    key: string;
    query?: Record<string, string>;
    body?: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<Response> {
    const { url, canonicalUri } = this.objectUrl(req.key);
    const query = req.query ?? {};
    const cqs = canonicalQueryString(query);
    const now = new Date();
    const amzDate = amzDateOf(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(req.body ?? new Uint8Array());

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.cfg.sessionToken) headers['x-amz-security-token'] = this.cfg.sessionToken;
    // Lowercase every supplied header name: SigV4 canonicalises on the lowercase
    // name and sorts on it, so a `Content-Type` from a caller would sort into a
    // different position than the `content-type` actually sent.
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;

    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    // Header values are trimmed AND internal whitespace runs collapsed, per the
    // SigV4 spec. Skipping the collapse silently breaks any value with a double
    // space in it -- e.g. a content-disposition filename.
    const canonicalHeaders = names.map((h) => `${h}:${canonicalHeaderValue(headers[h]!)}\n`).join('');

    const canonicalRequest = [
      req.method,
      canonicalUri,
      cqs,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const signature = this.sign(dateStamp, amzDate, scope, canonicalRequest);

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const target = cqs === '' ? `${url.origin}${canonicalUri}` : `${url.origin}${canonicalUri}?${cqs}`;
    // `host` is set by the HTTP client from the URL and cannot be overridden in
    // undici; it is in `headers` only so that it is signed. Sending it too is
    // harmless where allowed and rejected where not, so it is dropped here and
    // the signature is still computed over the value the client will send.
    const { host: _host, ...wire } = headers;
    return fetch(target, {
      method: req.method,
      headers: wire,
      ...(req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD'
        ? { body: req.body as unknown as BodyInit }
        : {}),
    });
  }
}

// -----------------------------------------------------------------------------
// SigV4 primitives
// -----------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function amzDateOf(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * RFC 3986 unreserved-set encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone and `encodeURI` additionally leaves
 * `#?&=+,:;@$` alone. The previous implementation used `encodeURI` on the whole
 * key, which meant a key containing `#` truncated the URL at the fragment, a key
 * containing `?` started a query string, and a key containing `+` signed one
 * byte sequence and sent another. Keys are constructed by us today, but "the
 * caller never puts a `#` in a key" is not a property the type system carries.
 */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Sorted by encoded key, then encoded value. Empty values keep their `=`. */
export function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaderValue(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/**
 * Read until `n` bytes are available or the stream ends.
 *
 * `done` means "the stream is finished AND this is everything that was left",
 * which is what lets `putStream` decide between a one-shot PUT and multipart
 * without a second read.
 */
async function readAtLeast(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<{ chunk: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) return { chunk: concat(chunks, total), done: true };
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  return { chunk: concat(chunks, total), done: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? (m[1] ?? null) : null;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Turn an S3 error response into an Error carrying the store's own error code.
 *
 * The status alone is not enough to act on: `AccessDenied`, `SignatureDoesNotMatch`
 * and `InvalidAccessKeyId` are all 403 and mean three completely different
 * operational problems (permissions / our bug / rotated key). Throwing the raw
 * status is how a signing bug spends a week being investigated as an IAM policy.
 */
async function s3Error(op: string, res: Response): Promise<Error> {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const text = await res.text();
    code = xmlTag(text, 'Code');
    message = xmlTag(text, 'Message');
  } catch {
    /* body already consumed or not XML */
  }
  const err = new Error(
    `storage ${op} failed: ${res.status}${code ? ` ${code}` : ''}${message ? ` -- ${message}` : ''}`,
  );
  (err as Error & { s3Code?: string | null; status?: number }).s3Code = code;
  (err as Error & { s3Code?: string | null; status?: number }).status = res.status;
  return err;
}
