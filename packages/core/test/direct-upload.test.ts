/**
 * PRE-AUTHORIZED DIRECT UPLOAD.
 *
 * The feature reverses the byte ordering the rest of the library is built on.
 * `upload()` writes bytes and then commits a row, so that a crash in between
 * leaves an unreferenced object rather than a row pointing at nothing. Here the
 * row has to come first, because the bytes arrive later and from someone else.
 *
 * So the tests that matter most are not the happy path. They are:
 *
 *   - that a row whose bytes never arrived is UNREADABLE rather than broken,
 *     which is the `pending` state doing the job it was already in the schema
 *     for;
 *   - that the size and the content type are enforced by the OBJECT STORE and
 *     not merely documented, which is the hole every presigned-PUT tutorial
 *     ships;
 *   - that nothing a client sends can choose the object key, the owner, or the
 *     stored content type.
 *
 * Run against `test/local-s3.mjs`, which performs real AWS SigV4 verification
 * and recomputes the signature from the request AS RECEIVED. A 403 from it is
 * the same 403 AWS would give, which is what makes the two "attack" tests below
 * evidence rather than decoration.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createLocalS3 } from './local-s3.mjs';
import { createTestDb } from '../src/db.ts';
import {
  Filelayer,
  DIRECT_UPLOAD_ACKNOWLEDGEMENT,
  MAX_UPLOAD_TTL_SECONDS,
} from '../src/filelayer.ts';
import { MemoryStorage, S3Storage } from '../src/storage.ts';
import { rejects } from './helpers.ts';

const AK = 'AKIAFILELAYERTEST000';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

const ACK = { acknowledgeBytesBypassApplication: DIRECT_UPLOAD_ACKNOWLEDGEMENT } as const;

describe('direct upload', () => {
  let s3: ReturnType<typeof createLocalS3>;
  const sigFailures: unknown[] = [];

  before(async () => {
    s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK, bucket: 'fl-upload' });
    s3.server.on('sigfail', (v: unknown) => sigFailures.push(v));
    await s3.listen();
  });

  after(async () => {
    await s3.close();
  });

  const storage = () =>
    new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl-upload',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK,
    });

  /** A world with direct upload enabled and acknowledged. */
  async function world(
    cfg: { maxUploadBytes?: number; ttlSeconds?: number } = {},
  ) {
    const { db } = await createTestDb();
    const store = storage();
    const fl = new Filelayer(db, store, {
      baseUrl: 'http://localhost',
      directUpload: { ...ACK, maxUploadBytes: cfg.maxUploadBytes ?? 1024 * 1024, ...cfg },
    });
    const alice = (await fl.createActor('alice')).id;
    const bob = (await fl.createActor('bob')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    return { db, fl, store, alice, bob, org };
  }

  // ---------------------------------------------------------------------------
  // It is off unless you say the sentence.
  // ---------------------------------------------------------------------------

  describe('opt-in', () => {
    it('refuses when directUpload was not configured at all', async () => {
      const { db } = await createTestDb();
      const fl = new Filelayer(db, storage(), { baseUrl: 'http://localhost' });
      const alice = (await fl.createActor('alice')).id;
      const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      await rejects(
        () =>
          fl.createUpload({ actorId: alice }, org, {
            name: 'a.txt',
            contentType: 'text/plain',
            size: 5,
          }),
        501,
      );
    });

    it('refuses an acknowledgement that is not the verbatim string', async () => {
      const { db } = await createTestDb();
      assert.throws(
        () =>
          new Filelayer(db, storage(), {
            directUpload: {
              // The near-miss is the case worth testing: someone retyping it.
              acknowledgeBytesBypassApplication:
                'I accept that upload bytes bypass my application' as typeof DIRECT_UPLOAD_ACKNOWLEDGEMENT,
              maxUploadBytes: 1024,
            },
          }),
        /direct_upload_not_acknowledged/,
      );
    });

    it('refuses a missing or nonsensical maxUploadBytes, with no default', async () => {
      const { db } = await createTestDb();
      for (const max of [undefined, 0, -1, 1.5, NaN, Infinity]) {
        assert.throws(
          () =>
            new Filelayer(db, storage(), {
              directUpload: { ...ACK, maxUploadBytes: max as number },
            }),
          /direct_upload_bad_max/,
          `maxUploadBytes: ${String(max)} should have been refused`,
        );
      }
    });

    it('refuses a TTL too short to survive a real network, and clamps a long one', async () => {
      const { db } = await createTestDb();
      assert.throws(
        () =>
          new Filelayer(db, storage(), {
            directUpload: { ...ACK, maxUploadBytes: 1024, ttlSeconds: 5 },
          }),
        /direct_upload_bad_ttl/,
      );

      // Clamped, not rejected -- a config asking for a week keeps working.
      const w = await world({ ttlSeconds: 7 * 24 * 3600 });
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'a.txt',
        contentType: 'text/plain',
        size: 5,
      });
      const ttl = Math.round((r.upload.expiresAt.getTime() - Date.now()) / 1000);
      assert.ok(
        ttl <= MAX_UPLOAD_TTL_SECONDS && ttl > MAX_UPLOAD_TTL_SECONDS - 10,
        `expected the TTL clamped to ~${MAX_UPLOAD_TTL_SECONDS}, got ${ttl}`,
      );
    });

    it('an adapter that cannot mint an upload credential says so, and names itself', async () => {
      // MemoryStorage has no `presignPut`, because there is no URL that reaches
      // an in-process Map. Structurally unavailable rather than faked.
      const { db } = await createTestDb();
      const fl = new Filelayer(db, new MemoryStorage(), {
        directUpload: { ...ACK, maxUploadBytes: 1024 },
      });
      const alice = (await fl.createActor('alice')).id;
      const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const err = await fl
        .createUpload({ actorId: alice }, org, {
          name: 'a.txt',
          contentType: 'text/plain',
          size: 5,
        })
        .then(
          () => null,
          (e: { status: number; code: string; reason?: string }) => e,
        );
      assert.ok(err, 'expected a refusal');
      assert.equal(err.status, 501);
      assert.equal(err.code, 'direct_upload_unsupported');
      // Naming the provider is what sends the reader to the right layer.
      assert.match(String(err.reason), /memory/);
    });
  });

  // ---------------------------------------------------------------------------
  // The decision happens before the credential exists. That is the whole claim.
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('a non-member gets no credential', async () => {
      const w = await world();
      await rejects(
        () =>
          w.fl.createUpload({ actorId: w.bob }, w.org, {
            name: 'a.txt',
            contentType: 'text/plain',
            size: 5,
          }),
        // 404, NOT 403. The uniform-404 rule: a refusal that confirms the org
        // exists is an enumeration oracle across tenants. My first draft of
        // this test asserted 403 and was wrong about the product, not the code.
        404,
      );
    });

    it('an anonymous caller gets no credential', async () => {
      const w = await world();
      await rejects(
        () =>
          w.fl.createUpload({ actorId: null }, w.org, {
            name: 'a.txt',
            contentType: 'text/plain',
            size: 5,
          }),
        404,
      );
    });

    it('the owner is the authorized principal and is not an input', async () => {
      // There is no `owner` field on the input at all -- this asserts the
      // consequence. `upload()` once took a bare actorId and the example passed
      // a value out of the request body; the shape that allowed it is absent
      // here by construction.
      const w = await world();
      await w.fl.addMember({ actorId: w.alice }, w.org, w.bob, 'member');
      const r = await w.fl.createUpload({ actorId: w.bob }, w.org, {
        name: 'bobs.txt',
        contentType: 'text/plain',
        size: 5,
      });
      assert.equal(r.file.ownerId, w.bob);
    });

    it('ignores an owner smuggled into the input', async () => {
      // There is no `owner` field on the input TYPE, so this cannot be written
      // by accident -- but the type is a compile-time protection and the
      // property it protects is a runtime one. `upload()` once took a bare
      // actorId and the example passed a value out of the request body, handing
      // permanent read access to whoever named themselves. Asserting the
      // runtime behaviour is what makes the protection survive a cast, a JS
      // caller, or a future signature change.
      const w = await world();
      await w.fl.addMember({ actorId: w.alice }, w.org, w.bob, 'member');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'a.txt',
        contentType: 'text/plain',
        size: 5,
        owner: w.bob,
        ownerId: w.bob,
        uploaderId: w.bob,
      } as unknown as { name: string; contentType: string; size: number });
      assert.equal(r.file.ownerId, w.alice, 'ownership came from the request body');
    });

    it('refuses a size above the configured ceiling', async () => {
      // "Pinned to exactly what the client asked for" is not a bound, which is
      // why `maxUploadBytes` has no default and this is a 413.
      const w = await world({ maxUploadBytes: 100 });
      await rejects(
        () =>
          w.fl.createUpload({ actorId: w.alice }, w.org, {
            name: 'big.bin',
            contentType: 'application/octet-stream',
            size: 101,
          }),
        413,
      );
    });

    it('refuses a size that is not an exact non-negative integer', async () => {
      const w = await world();
      for (const size of [-1, 1.5, NaN, Infinity, 2 ** 70]) {
        await rejects(
          () =>
            w.fl.createUpload({ actorId: w.alice }, w.org, {
              name: 'a.txt',
              contentType: 'text/plain',
              size,
            }),
          400,
        );
      }
    });

    it('a refused reservation writes no file row', async () => {
      const w = await world({ maxUploadBytes: 10 });
      await rejects(
        () =>
          w.fl.createUpload({ actorId: w.alice }, w.org, {
            name: 'big.bin',
            contentType: 'application/octet-stream',
            size: 999,
          }),
        413,
      );
      const { rows } = await w.db.query<{ n: string }>('SELECT count(*) n FROM file');
      assert.equal(Number(rows[0]!.n), 0);
    });
  });

  // ---------------------------------------------------------------------------
  // A reservation whose bytes never arrive. This is the state `upload()` works
  // hard to avoid, and the one this feature cannot avoid -- so it has to be
  // harmless.
  // ---------------------------------------------------------------------------

  describe('a reservation with no bytes', () => {
    it('is pending, with no size, and is NOT readable', async () => {
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'later.txt',
        contentType: 'text/plain',
        size: 11,
      });
      assert.equal(r.file.state, 'pending');
      // The claimed size is a claim and is not in `size_bytes`. Putting it
      // there would make one column mean "measured" on one path and "asserted
      // by a browser" on another.
      assert.equal(r.file.sizeBytes, null);

      // THE SAFETY PROPERTY. Even the owner cannot read it: `lifecycleDenial`
      // refuses `read` on a pending file. A row with no bytes is invisible
      // rather than broken.
      // 404 with an internal reason of `file_not_ready`: a reservation is not
      // merely unready to the owner, it is INDISTINGUISHABLE from absent. That
      // is stronger than this feature needs and it is the right default.
      await rejects(() => w.fl.read({ actorId: w.alice }, r.file.id), 404);
    });

    it('does not appear in a readable listing', async () => {
      const w = await world();
      await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'later.txt',
        contentType: 'text/plain',
        size: 11,
      });
      const page = await w.fl.listFiles({ actorId: w.alice }, w.org, { capability: 'read' });
      assert.equal(page.files.length, 0, 'a pending reservation must not be listed as readable');
    });

    it('completing it before the bytes exist is a retryable 409, not a 404', async () => {
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'later.txt',
        contentType: 'text/plain',
        size: 11,
      });
      const err = await w.fl.completeUpload({ actorId: w.alice }, r.file.id).then(
        () => null,
        (e: { status: number; code: string }) => e,
      );
      assert.ok(err);
      // The FILE exists; the bytes do not. A 404 would send the caller looking
      // for a lost id.
      assert.equal(err.status, 409);
      assert.equal(err.code, 'upload_not_received');

      // And the reservation survives, so the client can still upload.
      //
      // Read through SQL rather than `stat()`, and the reason is worth stating:
      // `stat()` authorizes `read`, which a pending file refuses, so there is
      // deliberately NO read-authorized way to observe a reservation. The
      // write-authorized listing below is the supported way to see one.
      const { rows } = await w.db.query<{ state: string }>(
        'SELECT state FROM file WHERE id = $1',
        [r.file.id],
      );
      assert.equal(rows[0]!.state, 'pending');
    });

    it('IS visible in a write-authorized listing, which is how a UI shows it', async () => {
      // The counterpart to the read tests above, and the answer to "then how
      // does an app show an upload in progress?". `listPredicate` is generated
      // from the same gate `authorize()` uses, and that gate scopes `pending`
      // to `read` alone -- so a reservation is invisible to a reader and
      // visible to whoever may write it, with no second rule to keep in sync.
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'later.txt',
        contentType: 'text/plain',
        size: 11,
      });
      const page = await w.fl.listFiles({ actorId: w.alice }, w.org, { capability: 'write' });
      assert.deepEqual(
        page.files.map((f) => f.id),
        [r.file.id],
      );
      assert.equal(page.files[0]!.state, 'pending');
    });

    it('two reservations never share an object key, and the client cannot choose one', async () => {
      const w = await world();
      const a = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'same-name.txt',
        contentType: 'text/plain',
        size: 1,
      });
      const b = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'same-name.txt',
        contentType: 'text/plain',
        size: 1,
      });
      assert.notEqual(a.file.storageKey, b.file.storageKey);
      // Derived, and scoped to the org: a client that could choose this could
      // aim an upload at another tenant's key.
      assert.match(a.file.storageKey, new RegExp(`^${w.org}/[0-9a-f-]{36}$`));
    });
  });

  // ---------------------------------------------------------------------------
  // The round trip.
  // ---------------------------------------------------------------------------

  describe('the round trip', () => {
    it('reserve, upload straight to the store, complete, read', async () => {
      const w = await world();
      const body = enc('hello direct');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'direct.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });

      // This is the request the BROWSER makes. Filelayer is not in it.
      assert.equal(r.upload.method, 'PUT');
      assert.equal(r.upload.via, 'storage');
      const put = await fetch(r.upload.url, {
        method: 'PUT',
        headers: r.upload.headers,
        body,
      });
      assert.equal(put.status, 200);

      const done = await w.fl.completeUpload({ actorId: w.alice }, r.file.id);
      assert.equal(done.state, 'ready');
      // MEASURED, not claimed: the store reported it.
      assert.equal(done.sizeBytes, body.byteLength);

      const got = await w.fl.read({ actorId: w.alice }, r.file.id);
      assert.equal(dec(got.body), 'hello direct');
      // The content type the application chose, pinned through the whole trip.
      assert.equal(got.file.contentType, 'text/plain');
    });

    it('completing twice is idempotent, because the network makes it so', async () => {
      const w = await world();
      const body = enc('once');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'once.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });

      const first = await w.fl.completeUpload({ actorId: w.alice }, r.file.id);
      const second = await w.fl.completeUpload({ actorId: w.alice }, r.file.id);
      assert.equal(first.state, 'ready');
      assert.equal(second.state, 'ready');
      assert.equal(second.sizeBytes, first.sizeBytes);
      assert.equal(second.id, first.id);
    });

    it('concurrent completions produce one ready file and no error', async () => {
      const w = await world();
      const body = enc('racing');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'race.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });

      const results = await Promise.all([
        w.fl.completeUpload({ actorId: w.alice }, r.file.id),
        w.fl.completeUpload({ actorId: w.alice }, r.file.id),
        w.fl.completeUpload({ actorId: w.alice }, r.file.id),
      ]);
      for (const res of results) {
        assert.equal(res.state, 'ready');
        assert.equal(res.sizeBytes, body.byteLength);
      }

      // AND IT IS BILLED AND AUDITED ONCE, which is the half the returned
      // records cannot show.
      //
      // The `AND state = 'pending'` in the UPDATE is what does this. Three
      // concurrent calls all pass the "already ready?" short-circuit, because
      // they read it before any of them has committed; without the predicate on
      // the UPDATE all three would succeed, and each would write an audit event
      // and meter the bytes again. One upload, billed three times. Removing
      // that predicate changes nothing about what the caller gets back, which
      // is exactly why it needs asserting here rather than there.
      const { rows: usage } = await w.db.query<{ s: string | null }>(
        `SELECT sum(bytes_stored)::text s FROM usage_daily WHERE org_id = $1`,
        [w.org],
      );
      assert.equal(Number(usage[0]?.s ?? 0), body.byteLength, 'the upload was metered more than once');

      const { rows: events } = await w.db.query<{ n: string }>(
        `SELECT count(*) n FROM audit_event
          WHERE file_id = $1 AND action = 'file.upload_complete' AND decision = 'allow'`,
        [r.file.id],
      );
      assert.equal(Number(events[0]!.n), 1, 'one completion, one event');
    });

    it('bills at completion, not at reservation: nothing stored is nothing billed', async () => {
      const w = await world();
      const body = enc('metered');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'm.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      const written = async () => {
        const { rows } = await w.db.query<{ s: string | null }>(
          `SELECT sum(bytes_stored)::text s FROM usage_daily WHERE org_id = $1`,
          [w.org],
        );
        return Number(rows[0]?.s ?? 0);
      };
      assert.equal(await written(), 0, 'a reservation must not be billed');

      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });
      await w.fl.completeUpload({ actorId: w.alice }, r.file.id);
      assert.equal(await written(), body.byteLength);
    });

    it('records the reservation and the completion in the audit chain', async () => {
      const w = await world();
      const body = enc('audited');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'a.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });
      await w.fl.completeUpload({ actorId: w.alice }, r.file.id);

      const { rows } = await w.db.query<{ action: string; context: Record<string, unknown> }>(
        `SELECT action, context FROM audit_event
          WHERE file_id = $1 AND decision = 'allow' ORDER BY id`,
        [r.file.id],
      );
      const actions = rows.map((x) => x.action);
      assert.ok(actions.includes('file.create'), `expected file.create in ${actions.join(',')}`);
      assert.ok(actions.includes('file.upload_complete'), actions.join(','));
      // A compliance reader filtering for direct uploads needs this to be on
      // the event rather than inferred from the absence of something.
      const created = rows.find((x) => x.action === 'file.create')!;
      assert.equal(created.context['method'], 'direct');
      assert.equal(created.context['expectedBytes'], body.byteLength);

      // The chain must still verify: these are new event shapes on a hash chain.
      const chain = await w.fl.verifyAuditChain({ actorId: w.alice }, w.org);
      assert.equal(chain.valid, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Abandoned reservations. Without a collector this feature is a slow leak of
  // rows nobody can see.
  // ---------------------------------------------------------------------------

  describe('collecting abandoned reservations', () => {
    /** Age a reservation past its deadline without sleeping for it. */
    const expire = async (
      w: Awaited<ReturnType<typeof world>>,
      fileId: string,
      secondsAgo: number,
    ) => {
      await w.db.query(
        `UPDATE file SET upload_expires_at = now() - ($2 || ' seconds')::interval WHERE id = $1`,
        [fileId, String(secondsAgo)],
      );
    };

    it('defaults to a dry run and deletes nothing', async () => {
      // The same default `collectStorageOrphans()` has, for the same reason:
      // this job's entire output is a list of things it is about to destroy.
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'abandoned.txt',
        contentType: 'text/plain',
        size: 5,
      });
      await expire(w, r.file.id, 7200);

      const planned = await w.fl.collectUploadReservations();
      assert.equal(planned.dryRun, true);
      assert.equal(planned.scanned, 1);
      assert.equal(planned.collected, 0);
      const { rows } = await w.db.query<{ n: string }>('SELECT count(*) n FROM file');
      assert.equal(Number(rows[0]!.n), 1, 'a dry run deleted a row');
    });

    it('collects the row and the bytes, and records it', async () => {
      const w = await world();
      const body = enc('arrived late, nobody completed');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'abandoned.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      // Bytes DID arrive; the completion call never came. This is the case that
      // costs money, so the object must go too.
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });
      assert.ok(await w.store.head(r.file.storageKey));
      await expire(w, r.file.id, 7200);

      const res = await w.fl.collectUploadReservations({ dryRun: false });
      assert.equal(res.collected, 1);
      assert.equal(await w.store.head(r.file.storageKey), null, 'the bytes were not reclaimed');

      const { rows } = await w.db.query<{ n: string }>(
        'SELECT count(*) n FROM file WHERE id = $1',
        [r.file.id],
      );
      // HARD deleted, not soft. A row with `deleted_at` set still references
      // its key, so `collectStorageOrphans()` would skip it forever and any
      // late-arriving bytes would be billed indefinitely.
      assert.equal(Number(rows[0]!.n), 0);

      // The record outlives the row, which is what `audit_event.file_id`
      // carrying no foreign key is for.
      const { rows: ev } = await w.db.query<{ n: string }>(
        `SELECT count(*) n FROM audit_event
          WHERE file_id = $1 AND action = 'file.upload_abandoned'`,
        [r.file.id],
      );
      assert.equal(Number(ev[0]!.n), 1);
    });

    it('leaves a reservation that is merely young alone', async () => {
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'in-flight.txt',
        contentType: 'text/plain',
        size: 5,
      });
      // Past its deadline but inside the grace period: a client may still be
      // mid-upload, and a reservation that survives one pass is collected on
      // the next. Deleting a live upload is not recoverable.
      await expire(w, r.file.id, 30);
      const res = await w.fl.collectUploadReservations({ dryRun: false, graceSeconds: 60 });
      assert.equal(res.scanned, 0);
      assert.equal(res.collected, 0);
    });

    it('floors the grace period, so it cannot be configured to zero', async () => {
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'in-flight.txt',
        contentType: 'text/plain',
        size: 5,
      });
      await expire(w, r.file.id, 10);
      // `graceSeconds: 0` would make the collector race the client on two
      // different clocks. It is floored at 60 instead of honoured.
      const res = await w.fl.collectUploadReservations({ dryRun: false, graceSeconds: 0 });
      assert.equal(res.collected, 0, 'a zero grace period was honoured');
    });

    it('NEVER touches a reservation that completed, even past the deadline', async () => {
      // THE RACE THAT DECIDES THE ORDERING. If the object were deleted before
      // the row was claimed, a completion landing in between would leave a
      // `ready` file with no bytes -- permanent, customer-visible loss.
      const w = await world();
      const body = enc('completed in time');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'done.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });
      await w.fl.completeUpload({ actorId: w.alice }, r.file.id);
      // Now age the (already ready) reservation well past its deadline.
      await expire(w, r.file.id, 7200);

      const res = await w.fl.collectUploadReservations({ dryRun: false });
      assert.equal(res.scanned, 0, 'a ready file was a collection candidate');
      assert.equal(res.collected, 0);
      // And it is still readable, bytes and all.
      assert.equal(dec((await w.fl.read({ actorId: w.alice }, r.file.id)).body), 'completed in time');
    });

    it('refuses to complete a reservation whose window has closed', async () => {
      // This is what makes the collector safe to run: once the deadline passes,
      // no completion can succeed, so there is no completion for the collector
      // to race.
      const w = await world();
      const body = enc('too late');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'late.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });
      await expire(w, r.file.id, 1);

      await rejects(() => w.fl.completeUpload({ actorId: w.alice }, r.file.id), 410);
      // Still pending, so it is the collector's to reclaim and not a half-file.
      const { rows } = await w.db.query<{ state: string }>(
        'SELECT state FROM file WHERE id = $1',
        [r.file.id],
      );
      assert.equal(rows[0]!.state, 'pending');
    });

    it('spares a reservation deleted BETWEEN its own select and delete', async () => {
      // The claim statement repeats `state = 'pending'` even though the select
      // that found the candidate already filtered on it. This is the test that
      // says why: the two statements are not atomic with respect to each other,
      // and something can change the row in between.
      //
      // Here it is an admin calling `delete()` on a reservation -- which soft
      // deletes the row and removes any bytes. Without the predicate on the
      // DELETE, the collector would then HARD delete that row, destroying the
      // `deleted_at` a retention policy reads and filing a
      // `file.upload_abandoned` event for a file somebody deliberately removed.
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'interleaved.txt',
        contentType: 'text/plain',
        size: 5,
      });
      await expire(w, r.file.id, 7200);

      // Hook the candidate query and interleave the delete after it resolves.
      let interleaved = false;
      const realQuery = w.db.query.bind(w.db);
      const hooked = new Proxy(w.db, {
        get(t, prop, recv) {
          if (prop === 'query') {
            return async (sql: string, params?: unknown[]) => {
              const out = await realQuery(sql, params as never);
              if (!interleaved && /ORDER BY upload_expires_at ASC/.test(sql)) {
                interleaved = true;
                await w.fl.delete({ actorId: w.alice }, r.file.id);
              }
              return out;
            };
          }
          // Bound to the TARGET, not the proxy. pglite's client keeps state in
          // ECMAScript private fields, and a method invoked with the proxy as
          // `this` cannot read them -- `TypeError: Cannot read from private
          // field`, from inside `transaction()`. Binding here is what keeps the
          // hook to `query` and out of everything else.
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });

      const racing = new Filelayer(hooked, w.store, {
        directUpload: { ...ACK, maxUploadBytes: 1024 * 1024 },
      });
      const res = await racing.collectUploadReservations({ dryRun: false });
      assert.ok(interleaved, 'the interleave never happened; this test proved nothing');
      assert.equal(res.scanned, 1, 'the candidate was found before the delete landed');
      assert.equal(res.collected, 0, 'the collector hard-deleted a row it no longer owned');

      // The soft-deleted row survives, with its tombstone intact.
      const { rows } = await w.db.query<{ state: string; deleted_at: string | null }>(
        'SELECT state, deleted_at FROM file WHERE id = $1',
        [r.file.id],
      );
      assert.equal(rows.length, 1, 'the tombstone a retention policy reads was destroyed');
      assert.equal(rows[0]!.state, 'deleted');
      assert.ok(rows[0]!.deleted_at);

      // And no event claims it was abandoned, because it was not.
      const { rows: ev } = await w.db.query<{ n: string }>(
        `SELECT count(*) n FROM audit_event
          WHERE file_id = $1 AND action = 'file.upload_abandoned'`,
        [r.file.id],
      );
      assert.equal(Number(ev[0]!.n), 0);
    });

    it('ignores a pending row that is not an upload reservation', async () => {
      // `state` DEFAULTS to 'pending' in the schema, so a row can be pending
      // without ever having been a reservation. The collector keys off
      // `upload_expires_at IS NOT NULL` rather than off the state, so it can
      // never delete a row it did not create.
      const w = await world();
      const { rows } = await w.db.query<{ id: string }>(
        `INSERT INTO file (org_id, owner_id, name, content_type, storage_provider,
                           storage_key, state)
         VALUES ($1,$2,'hand-made','text/plain','s3','handmade/key','pending')
         RETURNING id`,
        [w.org, w.alice],
      );
      const res = await w.fl.collectUploadReservations({ dryRun: false });
      assert.equal(res.scanned, 0);
      const { rows: still } = await w.db.query<{ n: string }>(
        'SELECT count(*) n FROM file WHERE id = $1',
        [rows[0]!.id],
      );
      assert.equal(Number(still[0]!.n), 1);
    });
  });

  // ---------------------------------------------------------------------------
  // The hole every presigned-PUT write-up ships. Verified against real SigV4.
  // ---------------------------------------------------------------------------

  describe('the object store enforces what was signed', () => {
    it('refuses a body larger than the size the credential was issued for', async () => {
      const w = await world();
      const promised = enc('small');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'avatar.bin',
        contentType: 'application/octet-stream',
        size: promised.byteLength,
      });

      // The attack, exactly as the guide describes it: the client does not
      // repeat the signed `content-length`, it sends a much bigger body with
      // the real one. Against a presigned PUT that signed only the key and the
      // content type, this SUCCEEDS and stores three gigabytes.
      const huge = new Uint8Array(64 * 1024);
      const res = await fetch(r.upload.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: huge,
      });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /SignatureDoesNotMatch/);

      // Nothing was stored, so the reservation cannot be completed.
      assert.equal(await w.store.head(r.file.storageKey), null);
      await rejects(() => w.fl.completeUpload({ actorId: w.alice }, r.file.id), 409);
    });

    it('refuses a content type other than the one the application chose', async () => {
      // An uploader who can store `text/html` under a key the app will serve
      // has stored XSS. The type is signed, so they cannot.
      const w = await world();
      const body = enc('<script>alert(1)</script>');
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'note.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      const res = await fetch(r.upload.url, {
        method: 'PUT',
        headers: { 'content-length': String(body.byteLength), 'content-type': 'text/html' },
        body,
      });
      assert.equal(res.status, 403);
      assert.equal(await w.store.head(r.file.storageKey), null);
    });

    it('refuses an upload to a key no reservation issued', async () => {
      const w = await world();
      const r = await w.fl.createUpload({ actorId: w.alice }, w.org, {
        name: 'a.txt',
        contentType: 'text/plain',
        size: 5,
      });
      // Repointing the signed URL at another key invalidates the signature,
      // which is what stops a credential for one file being authority over the
      // whole bucket.
      const elsewhere = r.upload.url.replace(r.file.id, '00000000-0000-4000-8000-000000000000');
      const res = await fetch(elsewhere, {
        method: 'PUT',
        headers: r.upload.headers,
        body: enc('xxxxx'),
      });
      assert.equal(res.status, 403);
    });

    it('and if a store accepts the wrong size anyway, completion refuses it', async () => {
      // THE CHECK THAT CANNOT FIRE ON AWS OR R2, TESTED ANYWAY.
      //
      // `content-length` is in the signed headers, so on a store that verifies
      // SigV4 properly a wrong-sized body never gets a 200 -- the test above
      // proves that. This one covers the case where that assumption is false:
      // an S3-compatible store that checks the signature but not every header
      // the signature covers.
      //
      // It matters because the acknowledgement string the operator typed says
      // the size is "enforced by the object store". If a store quietly does not,
      // the alternative to this check is `size_bytes` silently becoming
      // "whatever arrived" -- the exact thing the feature promises it is not.
      // Simulated with an adapter that reports a size the reservation did not
      // authorize, which is indistinguishable, from here, from a store that
      // accepted the wrong body.
      const { db } = await createTestDb();
      const inner = storage();
      const lying = new Proxy(inner, {
        get(t, prop, recv) {
          if (prop === 'head') {
            return async (key: string) => {
              const h = await inner.head(key);
              return h ? { ...h, size: h.size + 4096 } : null;
            };
          }
          return Reflect.get(t, prop, recv) as unknown;
        },
      }) as S3Storage;

      const fl = new Filelayer(db, lying, {
        directUpload: { ...ACK, maxUploadBytes: 1024 * 1024 },
      });
      const alice = (await fl.createActor('alice')).id;
      const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const body = enc('honest bytes');
      const r = await fl.createUpload({ actorId: alice }, org, {
        name: 'a.txt',
        contentType: 'text/plain',
        size: body.byteLength,
      });
      await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body });

      const err = await fl.completeUpload({ actorId: alice }, r.file.id).then(
        () => null,
        (e: { status: number; code: string }) => e,
      );
      assert.ok(err, 'a size the reservation did not authorize must not become size_bytes');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'upload_size_mismatch');

      // Still pending, so nothing became readable on a size nobody authorized.
      const { rows } = await db.query<{ state: string; size_bytes: string | null }>(
        'SELECT state, size_bytes FROM file WHERE id = $1',
        [r.file.id],
      );
      assert.equal(rows[0]!.state, 'pending');
      assert.equal(rows[0]!.size_bytes, null);

      // And the refusal is on the record, with both numbers, because this is
      // the event that tells an operator their store is not doing what the
      // acknowledgement said it would.
      const { rows: ev } = await db.query<{ context: Record<string, unknown> }>(
        `SELECT context FROM audit_event
          WHERE file_id = $1 AND decision = 'deny' AND action = 'file.upload_complete'`,
        [r.file.id],
      );
      assert.equal(ev.length, 1);
      assert.equal(ev[0]!.context['expectedBytes'], body.byteLength);
      assert.equal(ev[0]!.context['actualBytes'], body.byteLength + 4096);
    });

    it('every rejection above was a real signature failure at the store', () => {
      // Guards against the tests passing for the wrong reason -- a 403 from a
      // typo in the URL rather than from verification. The harness emits this
      // only after recomputing the signature and finding a mismatch.
      assert.ok(
        sigFailures.length >= 3,
        `expected the harness to have rejected signatures, saw ${sigFailures.length}`,
      );
    });
  });
});
