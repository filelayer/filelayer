/**
 * FOUR JOBS TO SCHEDULE IS A COST, AND THE WRAPPER THAT HIDES IT IS A RISK.
 *
 * `runMaintenance()` exists so an operator schedules one thing. The danger in
 * any such wrapper is that it makes four jobs with different safety profiles
 * look like one job with one profile:
 *
 *   `audit_seal`          additive, always safe, always runs
 *   `upload_reservations` destructive, dry unless told otherwise
 *   `storage_orphans`     destructive, dry unless told otherwise
 *   `audit_trim`          destructive AND a retention decision this library
 *                         must not make for anyone
 *
 * So the assertions here are mostly about what the wrapper REFUSES to do on
 * the caller's behalf, which is the half a convenience method gets wrong:
 *
 *   1. It is dry by default. A wrapper that flipped four dry jobs live would
 *      delete objects for a reader who called it to see what it did.
 *   2. The audit trim does not happen without an explicit retention policy,
 *      and the skip is REPORTED rather than omitted -- a job nobody notices is
 *      absent is the exact failure `job_run` was added to remove.
 *   3. One failing job does not stop the other three, and does not pass
 *      silently: the call throws, with the summary attached, because a cron
 *      entry is judged by its exit status.
 *   4. Every run lands in `job_run` exactly as a direct call would, so the
 *      existing "has this job run lately?" alerting keeps working whichever
 *      way the operator invokes them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb } from '../src/db.ts';
import { FilelayerError } from '../src/errors.ts';
import { Filelayer, type MaintenanceSummary } from '../src/index.ts';
import { MemoryStorage, type StorageAdapter } from '../src/storage.ts';

/**
 * A store that cannot enumerate, which is how one job is broken without
 * touching the others.
 *
 * `collectStorageOrphans()` needs `list()` -- `canList()` tests for the method
 * rather than for a flag -- so an adapter that does not have it fails exactly
 * that job and leaves the other three healthy. Composed at construction and
 * passed in, rather than by deleting the method off a live instance: the
 * adapter is a parameter, so a test that needs a different one asks for a
 * different one.
 */
function unlistableStorage(): StorageAdapter {
  const inner = new MemoryStorage();
  // Delegation rather than subclassing, because `list` is an OPTIONAL member
  // of `StorageAdapter` and a subclass cannot un-declare what its base
  // declares. This is also closer to the real case: an adapter for a store
  // with no enumeration does not have the method, it does not have the method
  // set to undefined.
  return {
    provider: inner.provider,
    put: inner.put.bind(inner),
    get: inner.get.bind(inner),
    head: inner.head.bind(inner),
    delete: inner.delete.bind(inner),
    stream: inner.stream.bind(inner),
  };
}

async function scenario(storage: StorageAdapter = new MemoryStorage()) {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, storage, { baseUrl: 'http://localhost:3000' });
  const alice = (await fl.createActor('alice')).id;
  const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  await fl.upload({ actorId: alice }, org, {
    name: 'contract.pdf',
    contentType: 'application/pdf',
    body: new TextEncoder().encode('contract'),
  });
  return { fl, storage, org, alice };
}

const outcome = (s: MaintenanceSummary, job: string) => {
  const found = s.jobs.find((j) => j.job === job);
  assert.ok(found, `no outcome reported for ${job}; a job that did not run must still be named`);
  return found;
};

describe('runMaintenance', () => {
  it('reports all four jobs, every time', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance();
    assert.deepEqual(
      s.jobs.map((j) => j.job).sort(),
      ['audit_seal', 'audit_trim', 'storage_orphans', 'upload_reservations'],
      'a job missing from the summary is a job an operator cannot tell did not run',
    );
  });

  it('is DRY by default', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance();
    assert.equal(s.dryRun, true);
    const orphans = outcome(s, 'storage_orphans');
    assert.equal(orphans.status, 'ok');
    assert.equal(
      (orphans as { result: { deleted: number } }).result.deleted,
      0,
      'a default call must not delete anything',
    );
  });

  it('SKIPS the audit trim, with a reason, when given no retention policy', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance();
    const trim = outcome(s, 'audit_trim');
    assert.equal(trim.status, 'skipped');
    assert.deepEqual(s.skipped, ['audit_trim']);
    assert.match(
      (trim as { reason: string }).reason,
      /retention/i,
      'the reason must say what the caller would have to supply',
    );
  });

  it('runs the audit trim when a retention policy IS given', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance({ auditTrim: { keepLast: 1, note: 'test retention' } });
    assert.equal(outcome(s, 'audit_trim').status, 'ok');
    assert.deepEqual(s.skipped, []);
  });

  it('seals the chain, which is the one job that always acts', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance();
    assert.equal(outcome(s, 'audit_seal').status, 'ok');
  });

  it('records every run in job_run, exactly as a direct call would', async () => {
    // The alerting an operator already has keys off this table. If the wrapper
    // bypassed it, switching to `runMaintenance()` would silently turn off
    // every "this job has not run since..." alarm.
    const { fl } = await scenario();
    await fl.runMaintenance();
    const runs = await fl.store.latestJobRuns(null);
    for (const job of ['audit_seal', 'upload_reservations', 'storage_orphans']) {
      assert.ok(runs.get(job as never), `${job} did not land in job_run`);
    }
  });

  it('keeps going after a failure, and THROWS with the summary attached', async () => {
    // Break exactly one job, at construction: `collectStorageOrphans` needs an
    // adapter that can enumerate, and this one cannot.
    const { fl } = await scenario(unlistableStorage());

    let thrown: unknown;
    try {
      await fl.runMaintenance();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof FilelayerError, 'a failed job must not return quietly');
    const s = (thrown as FilelayerError & { summary?: MaintenanceSummary }).summary;
    assert.ok(s, 'the summary must travel with the error, or the other three outcomes are lost');
    assert.deepEqual(s.failed, ['storage_orphans']);
    assert.equal(
      outcome(s, 'audit_seal').status,
      'ok',
      'a job that ran before the failure must still be reported as having run',
    );
    assert.equal(
      outcome(s, 'upload_reservations').status,
      'ok',
      'one broken job must not stop the others; that is how one failure masks three',
    );
  });

  it('CONTROL: with every adapter healthy, the same call does not throw', async () => {
    // Without this, the test above is also satisfied by a method that always
    // throws.
    const { fl } = await scenario();
    const s = await fl.runMaintenance();
    assert.deepEqual(s.failed, []);
  });

  it('passes dryRun: false through to the destructive jobs', async () => {
    const { fl } = await scenario();
    const s = await fl.runMaintenance({ dryRun: false });
    assert.equal(s.dryRun, false);
    const res = outcome(s, 'upload_reservations');
    assert.equal(res.status, 'ok');
    assert.equal(
      (res as { result: { dryRun: boolean } }).result.dryRun,
      false,
      'the flag must reach the job, or `dryRun: false` is decoration',
    );
  });
});
