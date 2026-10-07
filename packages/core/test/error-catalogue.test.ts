/**
 * THE ERROR CATALOGUE, AS A PROMISE RATHER THAN A TABLE.
 *
 * `tools/build-errors.mjs` already checks that `errors.json` and `ERRORS.md`
 * are what `ERROR_CODES` renders to, and that every catalogued code is
 * reachable. That is a gate over the SOURCE. These are tests over the
 * BEHAVIOUR, which is a different question: what a caller actually gets.
 *
 * The property worth pinning is the one the published documents now state
 * outright, because a reader will write a `switch` that depends on it:
 *
 *     the status is a function of the code
 *
 * It is currently impossible to violate, since the constructor derives the
 * status and does not accept one. That is exactly why it is worth a test: if
 * somebody ever adds a status parameter back for a good reason, this fails and
 * the documents that promise it get looked at in the same commit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// IMPORTED FROM THE PACKAGE ENTRY, NOT FROM `../src/errors.ts`, and that is the
// point of this line. The first version of this file imported the module
// directly, so it passed while `0.19.0` shipped a catalogue that was not
// re-exported from `index.ts` and therefore not importable as
// `@filelayer/core` at all. A test that reaches past the surface it is meant
// to be testing will tell you the module works, which was never in doubt.
import { ERROR_CODES, FilelayerError, isErrorCode } from '../src/index.ts';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the error catalogue', () => {
  it('derives the status from the code, for every code', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      const e = new FilelayerError(code as keyof typeof ERROR_CODES);
      assert.equal(e.status, spec.status, `${code} should carry ${spec.status}`);
      assert.equal(e.code, code);
    }
  });

  it('gives every code a status, a meaning and a fix, none of them empty', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.ok(Number.isInteger(spec.status) && spec.status >= 400 && spec.status < 600,
        `${code} has an implausible status: ${spec.status}`);
      assert.ok(spec.meaning.length > 20, `${code} has no real meaning text`);
      assert.ok(spec.fix.length > 10, `${code} has no real fix text`);
    }
  });

  it('recognises its own codes and nothing else', () => {
    assert.equal(isErrorCode('not_found'), true);
    // The near-misses that motivated typing this at all.
    assert.equal(isErrorCode('not-found'), false);
    assert.equal(isErrorCode('NOT_FOUND'), false);
    assert.equal(isErrorCode('nonsense'), false);
    assert.equal(isErrorCode(''), false);
    // Not inherited from Object.prototype, which `in` would have told us.
    assert.equal(isErrorCode('toString'), false);
    assert.equal(isErrorCode('constructor'), false);
  });

  it('ships errors.json saying the same thing as the code', () => {
    // The generated artefact is what an agent reads. A test that only looked
    // at ERROR_CODES would pass while the shipped file said something else.
    const shipped = JSON.parse(readFileSync(join(PKG, 'errors.json'), 'utf8')) as {
      codes: Record<string, { status: number; meaning: string; fix: string }>;
    };
    assert.deepEqual(
      Object.keys(shipped.codes).sort(),
      Object.keys(ERROR_CODES).sort(),
      'errors.json and ERROR_CODES list different codes',
    );
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.equal(shipped.codes[code]!.status, spec.status, `${code}: status differs`);
      assert.equal(shipped.codes[code]!.meaning, spec.meaning, `${code}: meaning differs`);
      assert.equal(shipped.codes[code]!.fix, spec.fix, `${code}: fix differs`);
    }
  });

  it('never serializes the internal reason onto the code', () => {
    // `reason` is the enumeration oracle. It must stay a separate field, and
    // `message` must be the code, because a caller logging `e.message` should
    // not be the way a deny reason escapes.
    const e = new FilelayerError('not_found', 'no_membership');
    assert.equal(e.code, 'not_found');
    assert.equal(e.message, 'not_found');
    assert.equal(e.reason, 'no_membership');
    assert.ok(!JSON.stringify({ error: e.code }).includes('no_membership'));
  });

  it('carries required headers through, which is why 416 is answerable at all', () => {
    const e = new FilelayerError('range_not_satisfiable', 'past_end', { 'content-range': 'bytes */26' });
    assert.equal(e.status, 416);
    assert.equal(e.headers?.['content-range'], 'bytes */26');
  });
});

describe('the codes a caller actually meets are the catalogued ones', () => {
  it('refuses a stranger with a catalogued code', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
    const alice = (await fl.createActor('alice')).id;
    const bob = (await fl.createActor('bob')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    const file = await fl.upload({ actorId: alice }, org, {
      name: 'f.txt', contentType: 'text/plain', body: new TextEncoder().encode('x'),
    });

    await assert.rejects(
      () => fl.stat({ actorId: bob }, file.id),
      (err: unknown) => {
        assert.ok(err instanceof FilelayerError);
        assert.ok(isErrorCode(err.code), `${err.code} is not in the catalogue`);
        assert.equal(err.status, ERROR_CODES[err.code].status);
        return true;
      },
    );
  });

  it('refuses a bad cursor with a catalogued code', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
    const alice = (await fl.createActor('alice')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;

    await assert.rejects(
      () => fl.listFiles({ actorId: alice }, org, { cursor: 'not-a-cursor-we-issued' }),
      (err: unknown) => {
        assert.ok(err instanceof FilelayerError);
        assert.ok(isErrorCode(err.code), `${err.code} is not in the catalogue`);
        assert.equal(err.status, ERROR_CODES[err.code].status);
        return true;
      },
    );
  });
});
