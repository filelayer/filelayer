/**
 * THE PROXIED UPLOAD PATH HAD NO SIZE CEILING, AND THE DIRECT ONE DID.
 *
 * `createUpload()` -- opt-in, bytes bypass your process entirely -- has always
 * required `maxUploadBytes` and refused to construct without it. `upload()` --
 * the default, the path whose whole argument is that the bytes go THROUGH your
 * process so you keep control of them -- accepted an object of any size from
 * any authenticated member, bounded only by whatever the HTTP layer in front
 * happened to do.
 *
 * The asymmetry was backwards. The route that spends your memory, your
 * bandwidth and your storage bill was the unbounded one. An outside reviewer
 * listed "no upload size limit" among our gaps; they were right, and they were
 * describing the half of the product we tell people to use.
 *
 * WHAT THIS SUITE HOLDS APART, because a ceiling is easy to test in the way
 * that proves nothing:
 *
 *   1. The limit binds on a declared size, on a `Uint8Array`, and on a stream
 *      that never declares its length -- the last being the only one a caller
 *      cannot lie about and therefore the only one that matters.
 *   2. A refused upload leaves NO object behind. A cap that refuses the row
 *      but keeps the bytes has moved the bill, not removed it.
 *   3. THE CALIBRATION CONTROL. The same oversized stream, through an instance
 *      with `maxUploadBytes: null`, SUCCEEDS. Without it, every assertion here
 *      is also satisfied by a library that refuses this upload for some
 *      unrelated reason, and the suite would pass just as happily if the
 *      ceiling did not exist.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb } from '../src/db.ts';
import { FilelayerError } from '../src/errors.ts';
import { Filelayer } from '../src/index.ts';
import { MemoryStorage } from '../src/storage.ts';

const CAP = 1024;

/** An instance whose ceiling is `cap`, plus the store, so we can count objects. */
async function instance(cap: number | null | undefined) {
  const { db } = await createTestDb();
  const storage = new MemoryStorage();
  const fl = new Filelayer(db, storage, {
    baseUrl: 'http://localhost:3000',
    ...(cap === undefined ? {} : { maxUploadBytes: cap }),
  });
  // The raw API addresses orgs and actors by id, not by the names the facade
  // takes, so this goes through `createActor`/`createOrg` rather than
  // `fl.orgs.create` -- `upload()` is the method under test and it is the raw
  // one.
  const alice = (await fl.createActor('alice')).id;
  const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  return { fl, storage, alice, org };
}

/**
 * How many objects exist, counted through the adapter's own `list()` rather
 * than by reaching into its map. The point of these assertions is that a
 * refused upload leaves nothing behind for a BUCKET to bill, and `list()` is
 * what `collectStorageOrphans()` uses to find exactly that.
 */
async function objectCount(storage: MemoryStorage): Promise<number> {
  const { entries } = await storage.list('');
  return entries.length;
}

/** A stream that never declares its length, delivered in small chunks. */
function streamOf(total: number, chunk = 256): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

const put = (
  env: { fl: Filelayer; alice: string; org: string },
  body: Uint8Array | ReadableStream<Uint8Array>,
  size?: number,
) =>
  env.fl.upload({ actorId: env.alice }, env.org, {
    name: 'big.bin',
    contentType: 'application/octet-stream',
    body,
    ...(size === undefined ? {} : { size }),
  });

async function refusal(fn: () => Promise<unknown>): Promise<FilelayerError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof FilelayerError, `expected a FilelayerError, got ${String(e)}`);
    return e;
  }
  throw new Error('expected a refusal; the upload was accepted');
}

describe('the upload ceiling', () => {
  it('refuses a Uint8Array over the cap, before anything is written', async () => {
    const env = await instance(CAP);
    const err = await refusal(() => put(env, new Uint8Array(CAP + 1)));
    assert.equal(err.code, 'payload_too_large');
    assert.equal(await objectCount(env.storage), 0, 'a refusal on a known size must not write an object');
  });

  it('refuses a DECLARED size over the cap even when the body is a stream', async () => {
    const env = await instance(CAP);
    const err = await refusal(() => put(env, streamOf(8), CAP + 1));
    assert.equal(err.code, 'payload_too_large');
    assert.equal(await objectCount(env.storage), 0);
  });

  it('refuses a stream that EXCEEDS the cap without ever declaring a size', async () => {
    // The case that matters. `size` is advisory and a caller who wants to beat
    // a declared-size check simply does not declare one.
    const env = await instance(CAP);
    const err = await refusal(() => put(env, streamOf(CAP * 4)));
    assert.equal(err.code, 'payload_too_large');
    assert.equal(await objectCount(env.storage), 0, 'the partial object must be deleted, not left to be paid for');
  });

  it('refuses a stream that UNDERSTATES its size in the declaration', async () => {
    // Declaring 8 bytes and sending 4 KiB is the shape a size check alone
    // cannot catch, which is the entire reason the count happens mid-stream.
    const env = await instance(CAP);
    const err = await refusal(() => put(env, streamOf(CAP * 4), 8));
    assert.equal(err.code, 'payload_too_large');
    assert.equal(await objectCount(env.storage), 0);
  });

  it('STOPS READING at the cap rather than draining the stream first', async () => {
    // THE TEST THE OTHERS DO NOT REPLACE, and the reason is worth stating.
    //
    // Disabling the mid-stream counter leaves every assertion above GREEN,
    // because `MemoryStorage` buffers the body and the post-write backstop
    // then refuses on what it stored. The refusal is correct and the bill is
    // not: the process held four times the ceiling on the heap before saying
    // no, which is the exact failure a size limit exists to prevent.
    //
    // A refusal is therefore not the property to assert here. HOW MUCH WAS
    // READ is. A caller offering 4x the cap should have been cut off shortly
    // after crossing it, so `produced` stays near the ceiling instead of
    // reaching the total.
    // THE PROPERTY IS INDEPENDENCE, not an exact byte count. A stream with a
    // default queuing strategy reads one chunk ahead, so the counter sees the
    // crossing chunk only after the source has produced the next one; pinning
    // a precise bound would be pinning that implementation detail. What must
    // hold, and what a drained stream cannot fake, is that the bytes read do
    // not grow with the bytes OFFERED. Offer four times the ceiling and forty
    // times it, and the same amount should be read.
    const chunk = 256;
    const readWhenOffered = async (total: number) => {
      const env = await instance(CAP);
      let produced = 0;
      const counted = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced >= total) {
            controller.close();
            return;
          }
          const n = Math.min(chunk, total - produced);
          produced += n;
          controller.enqueue(new Uint8Array(n));
        },
      });
      const err = await refusal(() => put(env, counted));
      assert.equal(err.code, 'payload_too_large');
      assert.equal(await objectCount(env.storage), 0);
      return produced;
    };

    const small = await readWhenOffered(CAP * 4);
    const large = await readWhenOffered(CAP * 40);

    assert.equal(
      small,
      large,
      `read ${small} bytes when offered ${CAP * 4} and ${large} when offered ` +
        `${CAP * 40}. The amount read is tracking the amount offered, which means ` +
        'the stream is being drained and the ceiling applied afterwards.',
    );
    assert.ok(
      small <= CAP + 2 * chunk,
      `read ${small} bytes for a ${CAP}-byte ceiling; expected to stop within one ` +
        `chunk of read-ahead past it (${CAP + 2 * chunk})`,
    );
  });

  it('accepts a body at exactly the cap', async () => {
    const env = await instance(CAP);
    const rec = await put(env, new Uint8Array(CAP));
    assert.equal(rec.sizeBytes, CAP, 'the boundary is inclusive; off-by-one here is a real bug');
  });

  it('accepts a stream under the cap', async () => {
    const env = await instance(CAP);
    const rec = await put(env, streamOf(CAP - 1));
    assert.equal(rec.sizeBytes, CAP - 1);
  });

  // --- the calibration control ---------------------------------------------
  //
  // Everything above is also true of a library that refuses these uploads for
  // an unrelated reason. This is the assertion that says the ceiling is what
  // is doing the work: remove the ceiling, and the SAME oversized stream goes
  // through.
  it('CONTROL: with maxUploadBytes null, the same oversized stream is stored', async () => {
    const env = await instance(null);
    const rec = await put(env, streamOf(CAP * 4));
    assert.equal(rec.sizeBytes, CAP * 4);
    assert.equal(await objectCount(env.storage), 1);
  });

  it('defaults to a finite ceiling rather than to infinity', async () => {
    // The default is what every existing deployment gets without changing a
    // line, so it is the number that decides whether this fix is real.
    const { DEFAULT_MAX_UPLOAD_BYTES } = await import('../src/index.ts');
    assert.ok(Number.isSafeInteger(DEFAULT_MAX_UPLOAD_BYTES));
    assert.ok(DEFAULT_MAX_UPLOAD_BYTES > 0 && DEFAULT_MAX_UPLOAD_BYTES < Infinity);
    const env = await instance(undefined);
    const rec = await put(env, new Uint8Array(16));
    assert.equal(rec.sizeBytes, 16, 'the default must not break an ordinary upload');
  });

  it('refuses a nonsensical ceiling at construction, not at upload time', async () => {
    const { db } = await createTestDb();
    for (const bad of [0, -1, 1.5]) {
      assert.throws(
        () =>
          new Filelayer(db, new MemoryStorage(), {
            baseUrl: 'http://localhost:3000',
            maxUploadBytes: bad,
          }),
        (e: unknown) => e instanceof FilelayerError && e.code === 'invalid_argument',
        `maxUploadBytes: ${bad} should be refused`,
      );
    }
  });
});
