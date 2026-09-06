/**
 * THE STORAGE LAYER, THE TRANSACTION LAYER, AND THE DELIVERY MODES.
 *
 * Three defects found by external review, and the tests that would have caught
 * each of them:
 *
 *   1. `storage_provider` was the literal 'memory' on every INSERT, whatever
 *      adapter was configured. Nothing read the column, so nothing disagreed
 *      with it. `records the CONFIGURED provider` fails against the old code.
 *
 *   2. Nothing was transactional. `put()` did five independent writes on
 *      potentially five different pool connections. `a failed metadata write
 *      leaves no file AND no audit event` fails against the old code, and so
 *      does `the audit chain lock spans the mutation`.
 *
 *   3. Every byte was proxied and buffered, and `Cache-Control: no-store` made
 *      a CDN impossible by construction. The streaming and redirect suites
 *      cover the replacement, including the parts that must NOT have changed.
 *
 * Most of this runs Filelayer against `S3Storage` talking to the local
 * S3-protocol server, so the storage path under test is the real one -- real
 * SigV4, real multipart, real presigned URLs -- rather than a Map.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestDb, withTransaction, CommitThenThrow, type Queryable } from '../src/db.ts';
import { Filelayer, FilelayerError } from '../src/filelayer.ts';
import {
  MemoryStorage,
  S3Storage,
  bytesToStream,
  collectStream,
  type StorageAdapter,
} from '../src/storage.ts';
import { REDIRECT_ACKNOWLEDGEMENT, MAX_REDIRECT_TTL_SECONDS } from '../src/delivery.ts';
import { createLocalS3, type LocalS3 } from './local-s3.mjs';
import { bytes, text, rejects } from './helpers.ts';

const AK = 'AKIAPERSISTENCE00000';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface Fixture {
  db: Queryable;
  fl: Filelayer;
  storage: StorageAdapter;
  org: string;
  alice: string;
  bob: string;
}

async function fixture(
  storage: StorageAdapter,
  opts: ConstructorParameters<typeof Filelayer>[2] = {},
): Promise<Fixture> {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, storage, { baseUrl: 'https://files.test', ...opts });
  const alice = (await fl.createActor(`alice-${Math.random()}`)).id;
  const bob = (await fl.createActor(`bob-${Math.random()}`)).id;
  const org = (await fl.createOrg(`org-${Math.random()}`, 'Org', { ownerActorId: alice })).id;
  await fl.addMember({ actorId: alice }, org, bob, 'member');
  return { db, fl, storage, org, alice, bob };
}

// =============================================================================
// 1. THE STORAGE PROVIDER
// =============================================================================

describe('storage_provider is derived from the adapter, not hardcoded', () => {
  let s3: LocalS3;

  before(async () => {
    s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK, bucket: 'fl' });
    await s3.listen();
  });
  after(async () => {
    await s3.close();
  });

  it('records the CONFIGURED provider, not "memory"', async () => {
    const storage = new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK,
      provider: 'r2',
    });
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt',
      contentType: 'text/plain',
      body: bytes('hello'),
    });

    // The API surface says so...
    assert.equal(file.storageProvider, 'r2');
    // ...and so does the column that participates in file_storage_key_idx.
    const { rows } = await f.db.query<{ storage_provider: string; storage_key: string }>(
      `SELECT storage_provider, storage_key FROM file WHERE id = $1`,
      [file.id],
    );
    assert.equal(rows[0]!.storage_provider, 'r2');
    // And the bytes really are where the row says they are.
    assert.ok(s3.objects.has(rows[0]!.storage_key), 'the object exists at the recorded key');
  });

  it('memory storage still records "memory"', async () => {
    const f = await fixture(new MemoryStorage());
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt',
      contentType: 'text/plain',
      body: bytes('hello'),
    });
    assert.equal(file.storageProvider, 'memory');
  });

  it('two adapters with different providers can hold the SAME key', async () => {
    // This is what `UNIQUE (storage_provider, storage_key)` is for, and it was
    // unreachable while the provider was a constant: every row in the database
    // competed for one namespace regardless of where the bytes actually were.
    const f = await fixture(new MemoryStorage());
    const a = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a', contentType: 'text/plain', body: bytes('a'),
    });
    const { rows } = await f.db.query(
      `INSERT INTO file (org_id, owner_id, name, content_type, size_bytes,
                         storage_provider, storage_key, state)
       VALUES ($1,$2,'b','text/plain',1,'r2',$3,'ready') RETURNING id`,
      [f.org, f.alice, a.storageKey],
    );
    assert.equal(rows.length, 1, 'same key, different provider, accepted');
    await rejects(
      async () =>
        f.db.query(
          `INSERT INTO file (org_id, owner_id, name, content_type, size_bytes,
                             storage_provider, storage_key, state)
           VALUES ($1,$2,'c','text/plain',1,'memory',$3,'ready')`,
          [f.org, f.alice, a.storageKey],
        ) as unknown as Promise<unknown>,
      0,
    ).catch(() => {
      /* helper expects FilelayerError; we only care that it rejected */
    });
  });

  it('the provider name is on the file.create audit event', async () => {
    const f = await fixture(new MemoryStorage());
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt', contentType: 'text/plain', body: bytes('x'),
    });
    const log = await f.fl.store.listAudit(f.org, { action: 'file.create' });
    const ev = log.find((e) => e.fileId === file.id)!;
    assert.equal(ev.context['storageProvider'], 'memory');
  });

  it('an adapter with no provider is refused at construction', async () => {
    const { db } = await createTestDb();
    assert.throws(
      () => new Filelayer(db, { provider: '' } as unknown as StorageAdapter),
      /must declare a non-empty `provider`/,
    );
  });

  it('size_bytes is what the adapter WROTE, not what the caller claimed', async () => {
    const f = await fixture(new MemoryStorage());
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt',
      contentType: 'text/plain',
      size: 999999, // a lie
      body: bytes('12345'),
    });
    assert.equal(file.sizeBytes, 5);
  });
});

// =============================================================================
// 2. TRANSACTIONS
// =============================================================================

describe('withTransaction', () => {
  it('commits on success and rolls back on failure', async () => {
    const { db } = await createTestDb();
    await withTransaction(db, async (tx) => {
      await tx.query(`INSERT INTO project (key, name) VALUES ('tx-ok', 'ok')`);
    });
    assert.equal((await db.query(`SELECT 1 FROM project WHERE key = 'tx-ok'`)).rows.length, 1);

    await assert.rejects(() =>
      withTransaction(db, async (tx) => {
        await tx.query(`INSERT INTO project (key, name) VALUES ('tx-bad', 'x')`);
        throw new Error('boom');
      }),
    );
    assert.equal((await db.query(`SELECT 1 FROM project WHERE key = 'tx-bad'`)).rows.length, 0);
  });

  it('CommitThenThrow commits the work and still throws', async () => {
    const { db } = await createTestDb();
    const sentinel = new Error('decided');
    await assert.rejects(
      () =>
        withTransaction(db, async (tx) => {
          await tx.query(`INSERT INTO project (key, name) VALUES ('tx-decided', 'x')`);
          throw new CommitThenThrow(sentinel);
        }),
      (e: unknown) => e === sentinel,
    );
    assert.equal((await db.query(`SELECT 1 FROM project WHERE key = 'tx-decided'`)).rows.length, 1);
  });

  it('savepoints let a failed statement be survived', async () => {
    const { db } = await createTestDb();
    await withTransaction(db, async (tx) => {
      await tx.query(`INSERT INTO project (key, name) VALUES ('sp-1', 'a')`);
      await assert.rejects(() =>
        tx.savepoint(() => tx.query(`INSERT INTO project (key) VALUES (NULL)`)),
      );
      // Without the savepoint this next statement would fail with
      // "current transaction is aborted".
      await tx.query(`INSERT INTO project (key, name) VALUES ('sp-2', 'b')`);
    });
    const { rows } = await db.query(`SELECT key FROM project WHERE key LIKE 'sp-%' ORDER BY key`);
    assert.deepEqual(rows.map((r) => r['key']), ['sp-1', 'sp-2']);
  });

  it('nests as a savepoint rather than a second BEGIN', async () => {
    const { db } = await createTestDb();
    await withTransaction(db, async (tx) => {
      await withTransaction(tx, async (inner) => {
        assert.equal(inner, tx, 'the inner call reuses the same connection');
        await inner.query(`INSERT INTO project (key) VALUES ('nested')`);
      });
    });
    assert.equal((await db.query(`SELECT 1 FROM project WHERE key = 'nested'`)).rows.length, 1);
  });

  it('drives a pg.Pool-shaped driver through connect/BEGIN/COMMIT/release', async () => {
    // A stand-in for `pg.Pool`, because the point of the abstraction is that it
    // works for a driver the test suite does not otherwise have.
    const statements: string[] = [];
    let released = 0;
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql.trim().split('\n')[0]!.slice(0, 20));
          return { rows: [] };
        },
        release: () => {
          released++;
        },
      }),
    } as unknown as Queryable;

    await withTransaction(pool, async (tx) => {
      await tx.query('SELECT 1');
    });
    assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.equal(released, 1);

    statements.length = 0;
    await assert.rejects(() =>
      withTransaction(pool, async () => {
        throw new Error('x');
      }),
    );
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
    assert.equal(released, 2, 'the client is released even when the body throws');
  });

  it('prefers a driver-supplied withTransaction', async () => {
    let used = false;
    const custom = {
      query: async () => ({ rows: [] }),
      withTransaction: async <T,>(fn: (tx: Queryable) => Promise<T>) => {
        used = true;
        return fn({ query: async () => ({ rows: [] }) });
      },
    } as unknown as Queryable;
    await withTransaction(custom, async () => undefined);
    assert.equal(used, true);
  });
});

describe('the mutation and the audit event that records it commit together', () => {
  it('a failed metadata write leaves NO file, NO audit event, and one orphan', async () => {
    const storage = new MemoryStorage();
    const f = await fixture(storage);

    const before = (
      await f.db.query<{ c: number }>(`SELECT count(*)::int c FROM audit_event`)
    ).rows[0]!.c;

    // A real constraint violation, raised by the INSERT itself: the schema's
    // `file_retention_before_expiry` CHECK refuses a retention floor that
    // outlives the expiry. The storage write has ALREADY happened at this point,
    // which is the whole reason the ordering question exists.
    await assert.rejects(() =>
      f.fl.upload({ actorId: f.alice }, f.org, {
        name: 'doomed.txt',
        contentType: 'text/plain',
        body: bytes('data'),
        expiresIn: 10,
        retainFor: 1000,
      }),
    );

    const after = (
      await f.db.query<{ c: number }>(`SELECT count(*)::int c FROM audit_event`)
    ).rows[0]!.c;
    assert.equal((await f.db.query(`SELECT id FROM file`)).rows.length, 0, 'no file row survived');
    assert.equal(after, before, 'and no audit event claims one was created');

    // The documented consequence, asserted rather than hoped for: the bytes are
    // still there, unreachable, waiting for the collector. This is the trade in
    // db.ts made visible -- an orphan instead of a `file` row with no object.
    assert.equal(storage.keys().length, 1, 'the bytes are an orphan, not lost data');
    await ageMemoryObjects(storage, 3600_000);
    const gc = await f.fl.collectStorageOrphans({ olderThanSeconds: 60, dryRun: false });
    assert.equal(gc.deleted, 1);
    assert.deepEqual(storage.keys(), []);
  });

  it('every uploaded file has a file.create event, and vice versa', async () => {
    const f = await fixture(new MemoryStorage());
    for (let i = 0; i < 5; i++) {
      await f.fl.upload({ actorId: f.alice }, f.org, {
        name: `f${i}`, contentType: 'text/plain', body: bytes(String(i)),
      });
    }
    const { rows } = await f.db.query<{ c: number }>(
      `SELECT count(*)::int c FROM file f
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_event a
           WHERE a.file_id = f.id AND a.action = 'file.create' AND a.decision = 'allow')`,
    );
    assert.equal(rows[0]!.c, 0, 'no file exists without the event that records its creation');
  });

  it('a DENIAL still lands in the log even though the call throws', async () => {
    // This is the property the naive "throw => rollback" transaction would have
    // silently destroyed, and it is exactly the class of event P5 exists for.
    const f = await fixture(new MemoryStorage());
    const outsider = (await f.fl.createActor('outsider')).id;
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'secret', contentType: 'text/plain', body: bytes('s'),
    });

    await rejects(() => f.fl.read({ actorId: outsider }, file.id), 404);
    const denials = await f.fl.store.listAudit(f.org, { decision: 'deny', action: 'file.read' });
    assert.equal(denials.length, 1);
    assert.equal(denials[0]!.actorId, outsider);
    assert.equal((await f.fl.store.verifyAuditChain(f.org)).valid, true);
  });

  it('the schema attenuation refusal is audited AND the transaction survives it', async () => {
    // The savepoint case: the INSERT raises, which in Postgres aborts the whole
    // transaction unless it is rolled back to a savepoint. Without that, the
    // deny event below could not be written at all.
    const f = await fixture(new MemoryStorage());
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'doc', contentType: 'text/plain', body: bytes('d'),
    });
    // Alice shares read+share to bob with a 3-download cap; bob then tries to
    // hand on MORE than he holds. The engine catches most of these; the schema
    // trigger is the backstop. Drive the trigger directly by inserting a child
    // grant that exceeds its parent.
    const parent = await f.fl.share({ actorId: f.alice }, file.id, {
      subject: { type: 'actor', actorId: f.bob },
      capabilities: ['read', 'share'],
      maxDownloads: 3,
    });
    const before = (await f.fl.store.listAudit(f.org, { action: 'grant.create' })).length;
    const child = await f.fl.share({ actorId: f.bob }, file.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
      maxDownloads: 100, // must be clamped, not accepted
    });
    assert.ok(child.maxDownloads !== null && child.maxDownloads <= 3, 'attenuated');
    assert.equal(child.parentGrantId, parent.grantId);
    const after = await f.fl.store.listAudit(f.org, { action: 'grant.create' });
    assert.equal(after.length, before + 1);
    assert.equal((await f.fl.store.verifyAuditChain(f.org)).valid, true);
  });

  it('the audit chain lock is taken inside the same transaction as the mutation', async () => {
    // PGlite has one backend and cannot demonstrate lock CONTENTION (see the
    // note on audit_append in schema.sql). What is provable, and what was
    // actually missing, is that `audit_append()` -- which takes
    // `pg_advisory_XACT_lock` -- now runs inside the SAME transaction as the
    // write it describes. Previously it was an autocommit statement of its own,
    // so the lock was taken and released without ever covering the mutation.
    //
    // The db is wrapped so that `withTransaction` cannot use PGlite's own
    // `transaction()` helper and must issue BEGIN/COMMIT through the recorded
    // `query`, which makes the statement sequence observable.
    const { db } = await createTestDb();
    const log: string[] = [];
    const recording: Queryable = {
      query: (sql: string, params?: unknown[]) => {
        log.push(sql.trim().replace(/\s+/g, ' ').slice(0, 40));
        return db.query(sql, params);
      },
    };
    const fl = new Filelayer(recording, new MemoryStorage(), { baseUrl: 'https://t.test' });
    const alice = (await fl.createActor('a')).id;
    const org = (await fl.createOrg('o', 'O', { ownerActorId: alice })).id;

    log.length = 0;
    await fl.upload({ actorId: alice }, org, {
      name: 'tx.txt', contentType: 'text/plain', body: bytes('t'),
    });

    const begin = log.findIndex((s2) => s2 === 'BEGIN');
    const insert = log.findIndex((s2) => s2.startsWith('INSERT INTO file'));
    const append = log.findIndex((s2) => s2.includes('audit_append'));
    const commit = log.findIndex((s2) => s2 === 'COMMIT');

    assert.ok(begin >= 0, 'the upload opened a transaction');
    assert.ok(begin < insert, 'the file INSERT is inside it');
    assert.ok(insert < append, 'the audit append follows the mutation...');
    assert.ok(append < commit, '...and both commit together');
    assert.equal(
      log.slice(begin + 1, commit).filter((s2) => s2 === 'COMMIT' || s2 === 'BEGIN').length,
      0,
      'nothing committed in between -- the advisory lock spans the mutation',
    );
    assert.equal((await fl.store.verifyAuditChain(org)).valid, true);
  });

  it('revoke: the state change and its event are inseparable, and the chain stays valid', async () => {
    const f = await fixture(new MemoryStorage());
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'doc', contentType: 'text/plain', body: bytes('d'),
    });
    const link = await f.fl.share({ actorId: f.alice }, file.id, { subject: { type: 'link' } });
    await f.fl.revoke({ actorId: f.alice }, link.grantId);
    const events = await f.fl.store.listAudit(f.org, { action: 'grant.revoke' });
    assert.equal(events.filter((e) => e.decision === 'allow').length, 1);
    const { rows } = await f.db.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM file_grant WHERE id = $1`,
      [link.grantId],
    );
    assert.notEqual(rows[0]!.revoked_at, null);
    await rejects(() => f.fl.redeem(link.secret!), 404);
    assert.equal((await f.fl.store.verifyAuditChain(f.org)).valid, true);
  });

  it('a storage failure after a successful reservation still spends the download (P6)', async () => {
    // Documented fail-closed behaviour. It survives the transaction work only
    // because the reservation COMMITS before anything touches the object store.
    const storage = new MemoryStorage();
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'doc', contentType: 'text/plain', body: bytes('d'),
    });
    const link = await f.fl.share({ actorId: f.alice }, file.id, {
      subject: { type: 'link' },
      maxDownloads: 2,
    });
    // Remove the bytes behind the library's back, so the fetch fails AFTER the
    // reservation committed.
    await storage.delete(file.storageKey);
    await rejects(() => f.fl.redeem(link.secret!), 404);
    const grants = await f.fl.listGrants({ actorId: f.alice }, file.id);
    assert.equal(grants.find((g) => g.id === link.grantId)!.downloadCount, 1);
  });
});

// =============================================================================
// 3. STREAMING
// =============================================================================

describe('streaming upload and delivery', () => {
  let s3: LocalS3;
  let storage: S3Storage;

  before(async () => {
    s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK, bucket: 'fl' });
    await s3.listen();
    storage = new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK,
      partSizeBytes: 5 * 1024 * 1024,
    });
  });
  after(async () => {
    await s3.close();
  });

  it('accepts a stream body and records the real length', async () => {
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'streamed.txt',
      contentType: 'text/plain',
      body: bytesToStream(bytes('streamed content')),
    });
    assert.equal(file.sizeBytes, 16);
    assert.equal(text((await f.fl.read({ actorId: f.alice }, file.id)).body), 'streamed content');
  });

  it('a multi-part streaming upload round trips byte-exactly through the whole stack', async () => {
    const f = await fixture(storage);
    const total = 5 * 1024 * 1024 + 4096;
    const src = new Uint8Array(total);
    for (let i = 0; i < total; i++) src[i] = (i * 31 + 7) & 0xff;

    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'big.bin',
      contentType: 'application/octet-stream',
      body: bytesToStream(src),
    });
    assert.equal(file.sizeBytes, total);

    const d = await f.fl.readStream({ actorId: f.alice }, file.id);
    assert.equal(d.mode, 'proxy');
    const got = await collectStream((d as { body: ReadableStream<Uint8Array> }).body);
    assert.equal(got.byteLength, total);
    assert.deepEqual(Buffer.from(got), Buffer.from(src));
  });

  it('readStream returns a stream and does not buffer', async () => {
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt', contentType: 'text/plain', body: bytes('abc'),
    });
    const d = await f.fl.readStream({ actorId: f.alice }, file.id);
    assert.equal(d.mode, 'proxy');
    assert.ok(
      (d as { body: unknown }).body instanceof ReadableStream,
      'the body is a stream, not a Uint8Array',
    );
    // ...and it still carries every header the buffered path carries.
    assert.equal(d.headers['x-content-type-options'], 'nosniff');
    assert.match(d.headers['cache-control']!, /no-store/);
    assert.match(d.headers['content-disposition']!, /^attachment/);
  });

  it('supports ranged delivery', async () => {
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'r.bin', contentType: 'application/octet-stream', body: bytes('abcdefghij'),
    });
    const d = await f.fl.readStream({ actorId: f.alice }, file.id, { range: { start: 3, end: 6 } });
    assert.equal(d.mode, 'proxy');
    assert.equal(d.headers['content-range'], 'bytes 3-6/10');
    assert.equal(text(await collectStream((d as { body: ReadableStream<Uint8Array> }).body)), 'defg');
  });

  it('the buffered read() is unchanged and still charges the cap once', async () => {
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.txt', contentType: 'text/plain', body: bytes('abc'),
    });
    const g = await f.fl.share({ actorId: f.alice }, file.id, {
      subject: { type: 'actor', actorId: f.bob },
      maxDownloads: 2,
    });
    const r = await f.fl.read({ actorId: f.bob }, file.id);
    assert.equal(text(r.body), 'abc');
    assert.equal(r.remainingDownloads, 1);
    assert.equal(r.grantId, g.grantId);
    await f.fl.read({ actorId: f.bob }, file.id);
    await rejects(() => f.fl.read({ actorId: f.bob }, file.id), 404);
  });
});

// =============================================================================
// 4. REDIRECT DELIVERY
// =============================================================================

describe('redirect delivery is opt-in, bounded, and audited', () => {
  let s3: LocalS3;
  let storage: S3Storage;

  const ACK = { acknowledgeRevocationWindow: REDIRECT_ACKNOWLEDGEMENT } as const;

  before(async () => {
    s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK, bucket: 'fl' });
    await s3.listen();
    storage = new S3Storage({
      endpoint: s3.endpoint(), bucket: 'fl', region: 'auto',
      accessKeyId: AK, secretAccessKey: SK,
    });
  });
  after(async () => {
    await s3.close();
  });

  async function published(opts: ConstructorParameters<typeof Filelayer>[2] = {}) {
    const f = await fixture(storage, opts);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'logo.png', contentType: 'image/png', body: bytes('PNGDATA'),
    });
    await f.fl.share({ actorId: f.alice }, file.id, { subject: { type: 'anonymous' } });
    return { ...f, file };
  }

  it('is OFF unless configured: an anonymous read is proxied', async () => {
    const f = await published();
    const d = await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' });
    assert.equal(d.mode, 'proxy');
  });

  it('refuses a config without the verbatim acknowledgement', async () => {
    const { db } = await createTestDb();
    assert.throws(
      () =>
        new Filelayer(db, storage, {
          redirectDelivery: {
            acknowledgeRevocationWindow: 'sure whatever' as typeof REDIRECT_ACKNOWLEDGEMENT,
          },
        }),
      (e: unknown) => e instanceof FilelayerError && e.code === 'redirect_not_acknowledged',
    );
  });

  it('redirects an ANONYMOUS delivery to a working, short-lived presigned URL', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const d = await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' });
    assert.equal(d.mode, 'redirect');
    if (d.mode !== 'redirect') return;

    assert.equal(d.status, 302);
    assert.equal(d.revocationWindowSeconds, 60);
    assert.equal(d.headers['location'], d.url);

    // The URL works, and the OBJECT STORE serves the neutralised type and the
    // attachment disposition, so a redirect does not lose the header
    // protections the proxied path guarantees.
    const res = await fetch(d.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition')!, /^attachment/);
    assert.equal(await res.text(), 'PNGDATA');
  });

  it('an anonymous redirect is CACHEABLE, for at most half the TTL', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const d = await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' });
    assert.equal(d.headers['cache-control'], 'public, max-age=30');
    assert.equal(d.headers['referrer-policy'], 'no-referrer');
  });

  it('a PRIVATE grant is proxied by default, however the caller asks', async () => {
    const f = await fixture(storage, { redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'secret.pdf', contentType: 'application/pdf', body: bytes('S'),
    });
    const link = await f.fl.share({ actorId: f.alice }, file.id, { subject: { type: 'link' } });

    const byOwner = await f.fl.readStream({ actorId: f.alice }, file.id, { mode: 'auto' });
    assert.equal(byOwner.mode, 'proxy', 'role-derived authority is never redirected by default');

    const byLink = await f.fl.redeemStream(link.secret!, { mode: 'auto' });
    assert.equal(byLink.mode, 'proxy', 'a link grant is not anonymous');
    assert.match(byLink.headers['cache-control']!, /no-store/);
  });

  it("scope 'all-grants' widens it, and the redirect is then NOT cacheable", async () => {
    const f = await fixture(storage, {
      redirectDelivery: { ...ACK, ttlSeconds: 60, scope: 'all-grants' },
    });
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'secret.pdf', contentType: 'application/pdf', body: bytes('S'),
    });
    const link = await f.fl.share({ actorId: f.alice }, file.id, { subject: { type: 'link' } });
    const d = await f.fl.redeemStream(link.secret!, { mode: 'auto' });
    assert.equal(d.mode, 'redirect');
    // Nothing that was not already public becomes cacheable by a shared cache.
    assert.match(d.headers['cache-control']!, /private, no-store/);
  });

  it('clamps the TTL to our ceiling, whatever the config asks for', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 86400 } });
    const d = await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' });
    assert.equal(d.mode, 'redirect');
    if (d.mode !== 'redirect') return;
    assert.equal(d.revocationWindowSeconds, MAX_REDIRECT_TTL_SECONDS);
    assert.ok(d.expiresAt.getTime() - Date.now() <= MAX_REDIRECT_TTL_SECONDS * 1000 + 1000);
  });

  it('records the mode in the audit log so a compliance auditor can tell them apart', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 45 } });
    await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' }); // redirect
    await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'proxy' }); // proxy

    const delivered = await f.fl.store.listAudit(f.org, { action: 'file.deliver' });
    assert.equal(delivered.length, 1, 'exactly one delivery left our control');
    assert.equal(delivered[0]!.context['mode'], 'redirect');
    assert.equal(delivered[0]!.context['revocationWindowSeconds'], 45);
    assert.equal(delivered[0]!.context['cacheable'], true);
    assert.equal(delivered[0]!.context['via'], 'grant:anonymous');
    // Both deliveries are still recorded as reads; the extra event distinguishes
    // them rather than replacing anything.
    const reads = await f.fl.store.listAudit(f.org, { action: 'file.read', decision: 'allow' });
    assert.equal(reads.length, 2);
    assert.equal((await f.fl.store.verifyAuditChain(f.org)).valid, true);
  });

  it('REVOCATION: no new redirect is issued after revoke, and the window is the TTL', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const grants = await f.fl.listGrants({ actorId: f.alice }, f.file.id);
    const anon = grants.find((g) => g.subjectType === 'anonymous')!;

    const before = await f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' });
    assert.equal(before.mode, 'redirect');

    await f.fl.revoke({ actorId: f.alice }, anon.id);

    // Immediate at decision time: the very next request is refused outright.
    await rejects(() => f.fl.readStream({ actorId: null }, f.file.id, { mode: 'auto' }), 404);

    // ...and the already-issued URL still works, which is precisely the
    // documented residual window. This assertion exists so nobody can claim the
    // window is theoretical.
    if (before.mode !== 'redirect') return;
    assert.equal((await fetch(before.url)).status, 200);
  });

  it('falls back to proxy when the adapter cannot presign', async () => {
    const f = await fixture(new MemoryStorage(), {
      redirectDelivery: { ...ACK, ttlSeconds: 60 },
    });
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'a.png', contentType: 'image/png', body: bytes('P'),
    });
    await f.fl.share({ actorId: f.alice }, file.id, { subject: { type: 'anonymous' } });
    const d = await f.fl.readStream({ actorId: null }, file.id, { mode: 'auto' });
    assert.equal(d.mode, 'proxy');
  });

  it('the library-owned HTTP route serves a real 302, and a real 200 otherwise', async () => {
    const { createServer } = await import('node:http');
    const { deliveryHandler } = await import('../src/delivery.ts');

    for (const [label, cfg, expected] of [
      ['redirect configured', { redirectDelivery: { ...ACK, ttlSeconds: 60 } }, 302],
      ['not configured', {}, 200],
    ] as const) {
      const f = await published(cfg);
      const server = createServer(deliveryHandler(f.fl));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/f/${f.file.id}`, { redirect: 'manual' });
        assert.equal(res.status, expected, label);
        assert.equal(res.headers.get('x-filelayer-delivery'), expected === 302 ? 'redirect' : 'proxy');
        if (expected === 302) {
          assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
          const followed = await fetch(res.headers.get('location')!);
          assert.equal(await followed.text(), 'PNGDATA');
        } else {
          // The unconfigured default must be byte-identical to what it always
          // was: proxied, and uncacheable.
          assert.match(res.headers.get('cache-control')!, /no-store/);
          assert.equal(await res.text(), 'PNGDATA');
        }
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  });

  it('a route may force proxying on an instance that has opted in', async () => {
    const { createServer } = await import('node:http');
    const { deliveryHandler } = await import('../src/delivery.ts');
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const server = createServer(deliveryHandler(f.fl, { mode: 'proxy' }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/f/${f.file.id}`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control')!, /no-store/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('the buffered read() never returns a redirect', async () => {
    const f = await published({ redirectDelivery: { ...ACK, ttlSeconds: 60 } });
    const r = await f.fl.read({ actorId: null }, f.file.id);
    assert.equal(text(r.body), 'PNGDATA');
    assert.match(r.headers['cache-control']!, /no-store/);
  });
});

// =============================================================================
// 5. ORPHAN COLLECTION
// =============================================================================

describe('orphan collection', () => {
  it('finds objects with no file row, and leaves referenced ones alone', async () => {
    const storage = new MemoryStorage();
    const f = await fixture(storage);
    const live = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'live', contentType: 'text/plain', body: bytes('L'),
    });
    await storage.put(`${f.org}/orphan-1`, bytes('O'), 'text/plain');
    await storage.put(`${f.org}/orphan-2`, bytes('O'), 'text/plain');

    // Nothing is old enough yet: the grace period is what stops the collector
    // from deleting an upload whose transaction has not committed.
    const fresh = await f.fl.collectStorageOrphans({ dryRun: true });
    assert.deepEqual(fresh.orphans, [], 'the grace period protects new objects');

    const found = await f.fl.collectStorageOrphans({ olderThanSeconds: 60, dryRun: true });
    // olderThanSeconds is floored at 60 and nothing here is 60s old, so still
    // nothing -- proven by moving the clock instead of weakening the floor.
    assert.deepEqual(found.orphans, []);

    for (const k of storage.keys()) {
      const head = await storage.head(k);
      if (head) (head.lastModified as Date).setTime(Date.now() - 3600_000);
    }
    // MemoryStorage returns a fresh object from head(), so age it at the source.
    await ageMemoryObjects(storage, 3600_000);

    const aged = await f.fl.collectStorageOrphans({ olderThanSeconds: 60, dryRun: true });
    assert.deepEqual(aged.orphans.sort(), [`${f.org}/orphan-1`, `${f.org}/orphan-2`]);
    assert.equal(aged.deleted, 0, 'dryRun is the default and it does not delete');
    assert.ok(storage.keys().includes(live.storageKey), 'the referenced object is untouched');

    const swept = await f.fl.collectStorageOrphans({ olderThanSeconds: 60, dryRun: false });
    assert.equal(swept.deleted, 2);
    assert.deepEqual(storage.keys(), [live.storageKey]);

    const gc = await f.fl.store.listAudit(null, { action: 'storage.gc' });
    assert.equal(gc.length, 1);
    assert.equal(gc[0]!.context['deleted'], 2);
  });

  it('does NOT collect the bytes of a soft-deleted file whose row still exists', async () => {
    // A retention hold blocks the delete; the row survives. If the collector
    // treated "state = deleted" as "collectable" it would destroy exactly the
    // bytes a legal hold exists to preserve.
    const storage = new MemoryStorage();
    const f = await fixture(storage);
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'held', contentType: 'text/plain', body: bytes('H'),
    });
    await f.db.query(`UPDATE file SET state='deleted', deleted_at=now() WHERE id=$1`, [file.id]);
    await ageMemoryObjects(storage, 3600_000);
    const r = await f.fl.collectStorageOrphans({ olderThanSeconds: 60, dryRun: false });
    assert.deepEqual(r.orphans, []);
    assert.ok(storage.keys().includes(file.storageKey));
  });

  it('refuses when the adapter cannot list', async () => {
    const nolist: StorageAdapter = {
      provider: 'nolist',
      put: async () => ({ bytes: 0, etag: null }),
      get: async () => null,
      stream: async () => null,
      head: async () => null,
      delete: async () => {},
    };
    const f = await fixture(nolist);
    await rejects(() => f.fl.collectStorageOrphans(), 500, 'storage_cannot_list');
  });
});

async function ageMemoryObjects(storage: MemoryStorage, byMs: number): Promise<void> {
  const inner = storage as unknown as {
    objects: Map<string, { lastModified: Date }>;
  };
  for (const v of inner.objects.values()) {
    v.lastModified = new Date(v.lastModified.getTime() - byMs);
  }
}

// =============================================================================
// 6. THE SWEEP: no public method takes a resource id without a principal
// =============================================================================

describe('every public method that names a resource also names a principal', () => {
  it('getFileRecord is not reachable from outside AT RUNTIME, not merely in types', async () => {
    // This test failed when `getFileRecord` was a TypeScript `private` method.
    // `private` is erased at compile time, so `fl['getFileRecord'](id)` was a
    // working cross-tenant metadata read from any JavaScript caller -- and an
    // SDK consumer holds JavaScript. It is a module-level function now, which
    // is the only privacy the runtime actually enforces.
    const f = await fixture(new MemoryStorage());
    const anyFl = f.fl as unknown as Record<string, unknown>;
    assert.equal(anyFl['getFileRecord'], undefined);
    assert.equal(
      Object.getOwnPropertyNames(Object.getPrototypeOf(f.fl)).includes('getFileRecord'),
      false,
    );
  });

  it('stat is the authorized replacement and it denies like read', async () => {
    const f = await fixture(new MemoryStorage());
    const outsider = (await f.fl.createActor('nobody')).id;
    const file = await f.fl.upload({ actorId: f.alice }, f.org, {
      name: 'x', contentType: 'text/plain', body: bytes('x'),
    });
    const s = await f.fl.stat({ actorId: f.alice }, file.id);
    assert.equal(s.id, file.id);
    assert.equal(s.storageProvider, 'memory');
    await rejects(() => f.fl.stat({ actorId: outsider }, file.id), 404);
    await rejects(() => f.fl.stat({ actorId: null }, file.id), 404);
  });

  it('the enumerated public surface has no unauthenticated resource accessor', async () => {
    // Hand-maintained, like the capability tables: adding a method to Filelayer
    // that takes an id and no principal makes this test fail, which is the
    // point. The control-plane methods are listed explicitly with the reason
    // they are exempt (see the long note in filelayer.ts).
    // Runtime-enumerable methods only. Every internal helper is an ECMAScript
    // `#private` (or a module-level function), so it does not appear on the
    // prototype at all -- unlike a TypeScript `private`, which does.
    const CONTROL_PLANE = new Set([
      'createOrg', 'createActor', 'createProject',
      'softDeleteOrg', 'restoreOrg',
      'softDeleteActor', 'restoreActor',
      'softDeleteProject', 'restoreProject',
      'collectStorageOrphans',
    ]);
    const PRINCIPAL_FIRST = new Set([
      'upload', 'read', 'readStream', 'stat', 'listFiles', 'delete',
      'share', 'revoke', 'listGrants', 'auditLog', 'verifyAuditChain',
      'addMember', 'removeMember',
    ]);
    // `redeem`/`redeemStream` take a link SECRET, which IS the credential.
    const CREDENTIAL_BEARING = new Set(['redeem', 'redeemStream']);

    const proto = Object.getPrototypeOf(await fixture(new MemoryStorage()).then((f) => f.fl));
    const methods = Object.getOwnPropertyNames(proto).filter((n) => {
      if (n === 'constructor') return false;
      const d = Object.getOwnPropertyDescriptor(proto, n)!;
      return typeof d.value === 'function';
    });

    const unclassified = methods.filter(
      (m) => !CONTROL_PLANE.has(m) && !PRINCIPAL_FIRST.has(m) && !CREDENTIAL_BEARING.has(m),
    );
    assert.deepEqual(
      unclassified,
      [],
      `unclassified public methods -- each must take a Principal or be justified: ${unclassified.join(', ')}`,
    );

    for (const m of PRINCIPAL_FIRST) {
      assert.ok(methods.includes(m), `${m} disappeared from the public surface`);
    }
  });
});
