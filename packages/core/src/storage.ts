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

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';

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

/**
 * VALIDATED IN THE ADAPTER, because the failure was silent and widening.
 *
 * A malformed range was formatted straight into the `Range` header. RFC 9110
 * says a recipient MUST ignore a `Range` it cannot parse, so the store answered
 * 200 with the WHOLE object and the adapter reported it as an unranged read: a
 * caller who asked for six bytes got all of them, with nothing in the response
 * to say so. The two adapters in this file also disagreed about the same bad
 * input -- `MemoryStorage` returned null for a reversed range, a slice for a
 * fractional one, and `NaN` for `start: NaN` -- so a range test passing against
 * the in-memory double proved nothing about the S3 path.
 *
 * Refusing is the only option a caller can detect.
 */
export function assertRange(r: ByteRange): void {
  const bad = (why: string): never => {
    throw new Error(`invalid byte range: ${why}`);
  };
  if (!Number.isInteger(r.start) || r.start < 0) bad(`start must be a non-negative integer, got ${r.start}`);
  if (r.end === undefined) return;
  if (!Number.isInteger(r.end) || r.end < 0) bad(`end must be a non-negative integer, got ${r.end}`);
  if (r.end < r.start) bad(`end (${r.end}) is before start (${r.start})`);
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
// Filesystem adapter (a real disk, no bucket)
// -----------------------------------------------------------------------------

/**
 * BYTES ON A LOCAL DISK, because the gap between the two adapters was a wall.
 *
 * Until 0.9.0 this package shipped exactly two: `MemoryStorage`, which is a Map
 * that dies with the process, and `S3Storage`, which needs a bucket and real
 * credentials. Everything in between -- a laptop, a single VM, a container with
 * a volume, a CI job that wants persistence, anyone evaluating this before they
 * are willing to create an IAM user -- fell into the gap.
 *
 * We know the size of that gap because we measured it. An agent integrating this
 * library from npm, reading only the published documentation, hit exactly one
 * hard stop before its first stored byte: it needed persistent storage without a
 * bucket, found nothing, and wrote sixty lines of this itself from the type
 * definitions. That is sixty lines every reader was paying.
 *
 * WHAT IT IS FOR: local development, single-node deployments, evaluation, and
 * tests that need bytes to survive a restart.
 *
 * WHAT IT IS NOT FOR: more than one process or machine. There is no locking
 * across writers, no replication, and no durability story beyond whatever the
 * filesystem gives you. If two application servers share a bucket today, they
 * cannot share a directory tomorrow without a shared filesystem, and a shared
 * filesystem is not a thing this adapter makes safe.
 *
 * `presignGet` is deliberately absent, which is the honest answer rather than a
 * limitation: a presigned URL is a promise that some OTHER server will serve
 * bytes without asking us, and a local directory has no such server. Redirect
 * delivery is therefore unavailable here, and `canPresign()` reports that
 * correctly instead of failing at request time.
 */
/** The JSON line at the top of every object file written by `FsStorage`. */
interface FsHeader {
  key: string;
  contentType: string;
  etag: string;
  bytes: number;
  at: string;
}

/**
 * How far in we look for the header's newline before deciding the file is not
 * one of ours. Keys can be long -- a 400-character key is a test in this
 * repository -- and a truncated header has no newline at all, so a ceiling is
 * what keeps a stray file from being read into memory looking for one.
 */
const FS_HEADER_MAX = 1024 * 1024;

function isFsHeader(v: unknown): v is FsHeader {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h['key'] === 'string' &&
    typeof h['bytes'] === 'number' &&
    Number.isFinite(h['bytes']) &&
    h['bytes'] >= 0 &&
    (typeof h['contentType'] === 'string' || h['contentType'] === null) &&
    (typeof h['etag'] === 'string' || h['etag'] === null)
  );
}

export class FsStorage implements StorageAdapter {
  readonly provider: string;
  readonly #root: string;

  /**
   * @param root      directory to store objects under. Created if absent.
   * @param provider  value written to `file.storage_provider`. It is part of an
   *                  object's identity, so changing it on an existing
   *                  deployment points every row at a store that has nothing.
   */
  constructor(root: string, opts: { provider?: string } = {}) {
    this.#root = root;
    this.provider = opts.provider ?? 'fs';
  }

  /**
   * A KEY IS NOT A PATH, and treating it as one is the defect this method
   * exists to avoid.
   *
   * Filelayer's own keys are `<orgUuid>/<fileUuid>`, which are safe. This
   * adapter is public, so it can be handed anything: `../`, an absolute path, a
   * NUL, a name that means something else on Windows. Hashing the key gives a
   * fixed-shape path with no traversal, no case-folding surprise and no length
   * limit, at the cost of a directory you cannot read with `ls`. The key is
   * stored in the object's own header so the mapping stays inspectable.
   */
  #paths(key: string): { dir: string; obj: string } {
    const h = createHash('sha256').update(key, 'utf8').digest('hex');
    const dir = join(this.#root, h.slice(0, 2), h.slice(2, 4));
    return { dir, obj: join(dir, `${h}.obj`) };
  }

  /**
   * ONE FILE PER OBJECT: a JSON header line, a newline, then the bytes.
   *
   * THIS IS THE SECOND DESIGN, and the first one is why. It kept the bytes in
   * `<hash>.bin` and the metadata in `<hash>.json`, which is the obvious shape
   * and is wrong for one reason: TWO FILES CANNOT BE REPLACED ATOMICALLY. Every
   * variant of the ordering was tried and measured, and each one just moves the
   * window:
   *
   *   - Blob written in place, sidecar after: `writeFile` opens O_TRUNC, so
   *     every overwrite passed through a zero-length sidecar and a concurrent
   *     `list()` read an empty file. It reproduced on the first round of every
   *     run.
   *   - Both through temp+rename, blob renamed first: a crash between the two
   *     renames left bytes on disk that `list()` -- which walks headers,
   *     because the key is only recoverable from them -- could never report, so
   *     the orphan collector could never reclaim them.
   *   - Both through temp+rename, sidecar renamed first: no unreclaimable
   *     bytes, but a reader landing between the renames got the NEW header over
   *     the OLD bytes. `head()` returned an etag and a size describing content
   *     that was not in the file, which is the one error a caller cannot detect
   *     -- it is exactly what a validator is for. Measured at 7 bad reads in
   *     480 under load, and 0 when the machine was idle, which is the worst
   *     possible shape for a defect.
   *
   * One file has one rename, and `rename(2)` within a filesystem is atomic. A
   * reader sees the whole old object or the whole new one. There is no third
   * state to find, and no ordering to get right.
   *
   * The cost is that `cat` on the file shows a line of JSON before the bytes.
   * The key is already a SHA-256, so nobody was finding these files by name
   * anyway, and `head -1` on one now tells you which key it holds.
   */
  #encode(meta: FsHeader, bytes: Uint8Array): Uint8Array {
    const header = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
    const out = new Uint8Array(header.byteLength + bytes.byteLength);
    out.set(header, 0);
    out.set(bytes, header.byteLength);
    return out;
  }

  /**
   * OPEN ONCE, AND HAND THE OPEN DESCRIPTOR BACK.
   *
   * This returns the handle on purpose, and that is the second correction to
   * this adapter's concurrency. Putting the header and the payload in one file
   * made `put` a single atomic `rename`, but a READER that opened the file twice
   * -- once to read the header, once to read the bytes -- could still straddle
   * that rename and serve v1's etag with v2's bytes. Measured at 5 bad reads in
   * 480 with the rest of the suite running, and 0 on an idle machine.
   *
   * A descriptor on Unix refers to the INODE, not the name. Once this `open`
   * returns, a rename or an unlink of the path cannot change what the caller is
   * reading, so every read taken from this handle sees one version of the
   * object. That is what makes `stream()`'s etag, its `size` and its bytes the
   * same version, which is the only consistency guarantee an object store
   * actually makes -- and the one `Content-Length` and a validator depend on.
   *
   * CLOSING IS THE CALLER'S JOB. `stream()` hands the handle to a read stream
   * with `autoClose`, so a drained or destroyed body releases it; every other
   * caller closes it in a `finally`.
   *
   * It reads in 8 KiB steps until it finds the newline, because the header
   * contains the key and a key can be long -- a 400-character key is a test in
   * this repository. The ceiling stops a file that is not one of ours, or one
   * truncated mid-header, from being read into memory in the hope of finding a
   * newline that is not there.
   */
  async #open(
    path: string,
  ): Promise<{ fh: FileHandle; meta: FsHeader; offset: number; stat: Stats } | null> {
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
    let ok = false;
    try {
      // From the HANDLE, not the path: the same inode the bytes come from.
      const st = await fh.stat();
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(8192);
        const { bytesRead } = await fh.read(buf, 0, buf.byteLength, total);
        if (bytesRead === 0) return null; // no newline anywhere: not an object
        chunks.push(buf.subarray(0, bytesRead));
        const joined = Buffer.concat(chunks);
        const nl = joined.indexOf(0x0a);
        if (nl !== -1) {
          let meta: unknown;
          try {
            meta = JSON.parse(joined.subarray(0, nl).toString('utf8'));
          } catch {
            return null;
          }
          if (!isFsHeader(meta)) return null;
          ok = true;
          return { fh, meta, offset: nl + 1, stat: st };
        }
        total = joined.byteLength;
        if (total > FS_HEADER_MAX) return null;
      }
    } finally {
      // Every path that does NOT hand the handle out closes it here.
      if (!ok) await fh.close().catch(() => {});
    }
  }

  async put(
    key: string,
    body: PutBody,
    contentType: string,
    _opts: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    const bytes = body instanceof Uint8Array ? body : await collectStream(body);
    const { dir, obj } = this.#paths(key);
    await mkdir(dir, { recursive: true });
    const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
    const tmp = `${obj}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        tmp,
        this.#encode(
          { key, contentType, etag, bytes: bytes.byteLength, at: new Date().toISOString() },
          bytes,
        ),
      );
      await rename(tmp, obj);
    } finally {
      // A PARTLY WRITTEN TEMP FILE IS NOT GARBAGE SOMEONE ELSE COLLECTS. There
      // was no cleanup here at all: a put that failed on a full disk left a
      // `.tmp` that `list()` never reports, so `collectStorageOrphans` could
      // not reclaim it either. Verified against a real write failure.
      await rm(tmp, { force: true }).catch(() => {});
    }
    return { bytes: bytes.byteLength, etag };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { obj } = this.#paths(key);
    let whole: Buffer;
    try {
      whole = await readFile(obj);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
    const nl = whole.indexOf(0x0a);
    if (nl === -1) return null;
    return new Uint8Array(whole.subarray(nl + 1));
  }

  async head(key: string): Promise<ObjectHead | null> {
    const h = await this.#open(this.#paths(key).obj);
    if (!h) return null;
    try {
      return {
        // THE SIZE, THE ETAG AND THE MTIME ALL COME FROM ONE OPEN DESCRIPTOR,
        // which is the whole reason for the single-file format and for `#open`
        // handing the handle back: there is no way for these to describe
        // different versions of the object.
        size: h.meta.bytes,
        contentType: h.meta.contentType,
        etag: h.meta.etag,
        lastModified: h.stat.mtime,
      };
    } finally {
      await h.fh.close().catch(() => {});
    }
  }

  /**
   * A REAL STREAM, FROM THE DESCRIPTOR THE HEADER WAS READ FROM.
   *
   * The first version called `head()` for the size and then `get()` for the
   * bytes. A delete between the two returned `{ size: 65536, body: 0 bytes }`
   * -- a response claiming 64 KiB and sending none, undetectable by any HTTP
   * layer that trusts `ObjectStream.size`. And a ranged read buffered the WHOLE
   * object before slicing: a 10-byte range on a 100 MiB file grew resident
   * memory by 200 MiB, twice the object, because the slice copies.
   *
   * `fh.createReadStream({ start, end })` reads only the requested bytes from
   * the handle `#open` already holds. One descriptor for the header and the
   * payload is what makes the etag, the size and the bytes one version; reading
   * only the range is what keeps a 10-byte read a 10-byte read. The payload
   * offset comes from the header, so the caller's range is translated once,
   * here.
   */
  async stream(key: string, opts: { range?: ByteRange } = {}): Promise<ObjectStream | null> {
    // `assertRange` first: a garbage range must be refused before anything is
    // opened, so a bad call cannot leak a descriptor.
    if (opts.range) assertRange(opts.range);

    const h = await this.#open(this.#paths(key).obj);
    if (!h) return null;

    let closed = false;
    const close = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        await h.fh.close().catch(() => {});
      }
    };

    try {
      const total = h.meta.bytes;
      let start = 0;
      let end = total - 1;
      let ranged = false;
      if (opts.range) {
        start = opts.range.start;
        end = Math.min(opts.range.end ?? total - 1, total - 1);
        // Past the end is unsatisfiable, which is the answer S3 gives and which
        // the delivery layer turns into a 404.
        if (start > end) {
          await close();
          return null;
        }
        ranged = true;
      }

      const empty = total === 0 || end < start;
      let body: ReadableStream<Uint8Array>;
      if (empty) {
        await close();
        body = bytesToStream(new Uint8Array(0));
      } else {
        // autoClose releases the descriptor when the body is drained OR
        // destroyed, which covers a client that hangs up mid-download.
        const rs = h.fh.createReadStream({
          start: h.offset + start,
          end: h.offset + end,
          autoClose: true,
        });
        rs.on('close', () => {
          closed = true;
        });
        body = Readable.toWeb(rs) as ReadableStream<Uint8Array>;
      }

      const out: ObjectStream = {
        body,
        size: empty ? 0 : end - start + 1,
        contentType: h.meta.contentType,
        etag: h.meta.etag,
      };
      if (ranged) out.range = { start, end, total };
      return out;
    } catch (e) {
      await close();
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.#paths(key).obj);
    } catch (e) {
      // Deleting what is not there is success, as it is on S3.
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
  }

  /**
   * Present, so `collectStorageOrphans()` works here too. It reads each
   * object's header rather than its bytes, because the key is only recoverable
   * from the header and the payload is irrelevant to a listing.
   *
   * TWO THINGS HERE ARE DEFENSIVE ON PURPOSE, both of them measured.
   *
   * A FILE IT CANNOT READ A HEADER FROM SKIPS ITSELF AND NOTHING ELSE. The
   * first version did a bare `JSON.parse` on each sidecar, so one unreadable
   * file threw out of the whole walk: `collectStorageOrphans()` could then
   * enumerate nothing at all, and every object in the store became
   * unreclaimable because of one. It did not take corruption to produce --
   * ordinary concurrent writers did it -- and a listing that one bad file can
   * disable is wrong whatever wrote the file. `skipped` is reported rather than
   * hidden, so a caller can tell "nothing here" from "I could not read four of
   * these".
   *
   * AN UNREADABLE DIRECTORY THROWS INSTEAD OF READING EMPTY. The first version
   * caught every `readdir` error and returned, so a root with no read
   * permission produced `{ entries: [] }` -- indistinguishable from an empty
   * store. The caller is the orphan collector, and "nothing is stored" is the
   * one answer that makes it delete database rows for files that do exist.
   * ENOENT alone is benign, because a store nobody has written to yet has no
   * directory.
   */
  async list(
    prefix: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ entries: ListEntry[]; cursor: string | null; skipped?: number }> {
    // 1,000 is the ceiling on the other two adapters. It was 10,000 here, which
    // meant a caller that passed `limit: 5000` silently got a different page
    // size from a directory than from a bucket -- and for the orphan collector,
    // a short page it believes is complete is rows deleted for files that exist.
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    const found: ListEntry[] = [];
    let skipped = 0;
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return;
        // EACCES, ENOTDIR, EMFILE and friends are not "this directory is
        // empty". Hiding them is how a listing lies to the orphan collector.
        throw e;
      }
      for (const n of names.sort()) {
        const full = join(dir, n);
        const s = await stat(full).catch(() => null);
        if (s === null) continue;
        if (s.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!n.endsWith('.obj')) continue;
        const h = await this.#open(full).catch(() => null);
        if (!h) {
          skipped++;
          continue;
        }
        await h.fh.close().catch(() => {});
        if (!h.meta.key.startsWith(prefix)) continue;
        found.push({
          key: h.meta.key,
          // THE LENGTH ON DISK, not the length the header claims. They agree
          // for anything this adapter wrote; they disagree for a file that was
          // truncated after the fact, and the orphan collector is better served
          // by what is there than by what was intended.
          size: Math.max(0, h.stat.size - h.offset),
          lastModified: s.mtime,
        });
      }
    };
    await walk(this.#root);
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const after = opts.cursor ?? null;
    const start = after === null ? 0 : found.findIndex((e) => e.key > after);
    const slice = start < 0 ? [] : found.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const out: { entries: ListEntry[]; cursor: string | null; skipped?: number } = {
      entries: slice,
      // A CURSOR MUST NEVER BE `''`. The empty key is a legal key here, and
      // handing back `''` as the cursor ended an idiomatic `while (cursor)`
      // loop on its first iteration -- so a caller paging a store whose
      // alphabetically first object had the empty key saw one page and stopped.
      cursor: last && last.key !== '' && start + limit < found.length ? last.key : null,
    };
    if (skipped > 0) out.skipped = skipped;
    return out;
  }
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
      assertRange(opts.range);
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
    // `?? ''` here instead of `?? null` hid the key `''` from every page,
    // because `'' > ''` is false: with no cursor the first page already
    // excluded it, so an object stored under the empty key could be listed by
    // no call at all and `collectStorageOrphans()` could never reclaim it. The
    // empty key is reachable -- the adapter is exported and takes any string.
    const after = opts.cursor ?? null;
    const all = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix) && (after === null || k > after))
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
    // A 200 WITH NO ETag IS NOT A WRITE. Some S3-compatible stores and
    // intermediaries answer 200 carrying an `<Error>` document; `res.ok` is
    // true and nothing was stored. This method then returned a byte count that
    // became `file.size_bytes`, so the row described an object that did not
    // exist. `uploadPart` has treated a missing ETag as a failure all along --
    // this is the same check, on the path that writes every small file.
    const etag = res.headers.get('etag');
    if (etag === null) {
      throw new Error(
        `storage put failed: ${res.status} with no ETag, which means the store did not accept the object`,
      );
    }
    return { bytes: body.byteLength, etag };
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
    const carry: { rest: Uint8Array | null } = { rest: null };
    const first = await readAtLeast(reader, partSize, carry);

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
        const next = await readAtLeast(reader, partSize, carry);
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
    // UNESCAPE, as `list()` already does for Key. Without it a multipart upload
    // returned `&quot;...&quot;` while a single PUT returned `"..."`, so one
    // field had two formats depending on object size and neither consumer could
    // tell which it had. The escaped form is not a valid HTTP entity-tag.
    const etag = xmlTag(text, 'ETag');
    return etag === null ? null : unescapeXml(etag);
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
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    // STATUS BEFORE DRAIN. Draining first threw away the body `s3Error` reads,
    // so `head` and `delete` reported a bare status while every other method
    // reported the store's own error code -- exactly the detail an operator
    // needs, missing from two of the six methods for no reason but ordering.
    if (!res.ok) throw await s3Error('head', res);
    // A HEAD has no body to read, but undici still wants the (empty) body
    // consumed before the socket goes back to the pool.
    await res.arrayBuffer().catch(() => {});
    const len = res.headers.get('content-length');
    // UNKNOWN IS NOT ZERO. A chunked response, or an intermediary that dropped
    // the header, used to be reported as a zero-byte object -- and `stream()`
    // gets the identical case right twenty lines down, so one adapter gave two
    // answers about one response. Refusing is the honest option while
    // `ObjectHead.size` is a plain `number`.
    if (len === null) {
      throw new Error('storage head failed: the store returned no content-length, so the size is unknown');
    }
    const lm = res.headers.get('last-modified');
    return {
      size: Number(len),
      contentType: res.headers.get('content-type'),
      etag: res.headers.get('etag'),
      lastModified: lm ? new Date(lm) : null,
    };
  }

  async stream(key: string, opts: { range?: ByteRange } = {}): Promise<ObjectStream | null> {
    const headers: Record<string, string> = {};
    if (opts.range) {
      assertRange(opts.range);
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
    // S3 returns 204 for a delete of a key that never existed. 404 is here for
    // S3-compatible stores that disagree; either way "it is gone" is success.
    if (!res.ok && res.status !== 404) throw await s3Error('delete', res);
    const text = await res.text().catch(() => '');
    // A 200 CARRYING AN <Error> DOCUMENT IS NOT A DELETE, and this one matters
    // more than the others: the caller has already been told the bytes are
    // gone, and `file.state` is about to say so too. `completeMultipartUpload`
    // has guarded this shape all along; the path that removes every file did
    // not.
    if (text !== '' && /<Error>/.test(text)) {
      throw new Error(
        `storage delete failed with ${res.status} + Error body: ${xmlTag(text, 'Code') ?? text.slice(0, 200)}`,
      );
    }
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
    // `Math.max(1, Math.min(Math.floor(NaN), n))` is NaN: the clamp this method
    // documents is NaN-poisoned at every step, and the result was a signed
    // `X-Amz-Expires=NaN`. Being signed, it could not be stripped, and a store
    // parsing it with `parseInt` never found the URL expired. The finite cases
    // were always right; this is only the hole at the edge.
    if (!Number.isFinite(opts.expiresInSeconds)) {
      throw new Error('presign failed: expiresInSeconds must be a finite number');
    }
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
    // AN ENDPOINT PATH IS NOT SUPPORTED, so say so instead of dropping it.
    // Only protocol and host are used below, so `https://host/s3-gateway`
    // addressed `/bucket/key` and failed at the far end with something that
    // named neither the endpoint nor the prefix. The limitation is fine; the
    // silence was not.
    if (base.pathname !== '/' && base.pathname !== '') {
      throw new Error(
        `storage endpoint must not carry a path: got ${base.pathname}. ` +
          'Use pathStyle for bucket addressing.',
      );
    }
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
      // NEVER FOLLOW A REDIRECT. The signature covers the request we are
      // sending, and nothing covers wherever a 3xx points. Following one let an
      // endpoint that can shape its own responses substitute arbitrary bytes
      // for an authorized object -- Filelayer then serves those bytes under the
      // real file's pinned content-type and disposition, and audits a
      // successful read. It also forwarded `x-amz-security-token` to the
      // redirect target: undici strips `authorization` across origins and does
      // not strip that one, so an STS credential travelled to a host of the
      // redirector's choosing.
      //
      // A conformant S3 does not 3xx a GET of an existing object, so this costs
      // nothing and closes the case where the endpoint is a compromised
      // gateway, an on-path attacker on a non-TLS endpoint, or a bucket with
      // website-redirect behaviour. Found 3 October 2026.
      redirect: 'error',
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
/**
 * Read EXACTLY `n` bytes, or everything that is left.
 *
 * It used to read AT LEAST `n` and hand back whatever the last source chunk
 * brought with it, which made the documented invariant of `putStream` false:
 * "peak memory is bounded by ONE part regardless of object size" was really
 * bounded by one part PLUS the largest chunk the source happened to emit. A
 * single 12 MiB chunk against a 5 MiB part size produced a 12 MiB part,
 * measured off the wire -- and a large enough chunk would breach S3's own 5 GiB
 * per-part limit.
 *
 * `carry` holds the overshoot between calls, so the bound is now the one the
 * documentation claims.
 */
async function readAtLeast(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
  carry: { rest: Uint8Array | null },
): Promise<{ chunk: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (carry.rest !== null) {
    chunks.push(carry.rest);
    total += carry.rest.byteLength;
    carry.rest = null;
  }
  let done = false;
  while (total < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    if (!r.value || r.value.byteLength === 0) continue;
    chunks.push(r.value);
    total += r.value.byteLength;
  }
  if (total <= n) return { chunk: concat(chunks, total), done };
  const all = concat(chunks, total);
  carry.rest = all.subarray(n);
  // `done` is deliberately false: there are buffered bytes left to emit, even
  // if the source is finished.
  return { chunk: all.subarray(0, n), done: false };
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
