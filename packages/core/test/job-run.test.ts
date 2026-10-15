/**
 * A JOB THAT NEVER REPORTS IS INDISTINGUISHABLE FROM ONE THAT RAN AND FOUND
 * NOTHING.
 *
 * Three of the four jobs this library asks an operator to schedule are
 * published limitations -- entry 9, entry 4, entry 12 -- and each says nothing
 * calls it for you. What was missing is the same shape as limitation 11:
 * truncation of recent audit events is undetectable because nothing records
 * where the chain was supposed to end. A cron that has been failing for six
 * weeks produced exactly the same silence as one that had nothing to do.
 *
 * The first test asserts the thing that matters and would have been impossible
 * to assert before: that a job which has NEVER RUN says so, rather than
 * returning nothing and letting the caller read it as "fine".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Filelayer } from '../src/index.ts';

async function scenario() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  return fl;
}

describe('jobStatus', () => {
  it('reports NEVER RUN for every job on a fresh database', async () => {
    const fl = await scenario();
    const status = await fl.jobStatus();

    assert.equal(status.length, 4, 'all four jobs are enumerated, not just the ones with rows');
    for (const s of status) {
      assert.equal(s.lastRun, null, `${s.job} has never run and says so`);
      assert.equal(s.ageSeconds, null);
      assert.equal(s.stale, null, 'no cadence was declared, so staleness is not asserted');
    }
    assert.deepEqual(
      status.map((s) => s.job).sort(),
      ['audit_seal', 'audit_trim', 'storage_orphans', 'upload_reservations'],
    );
  });

  it('calls a never-run job stale the moment a cadence is declared', async () => {
    const fl = await scenario();
    // The worst case must not hide behind the absence of data: a job that has
    // never run is stale against any expectation at all.
    const status = await fl.jobStatus({ staleAfter: { storage_orphans: 86_400 } });
    const orphans = status.find((s) => s.job === 'storage_orphans')!;
    assert.equal(orphans.lastRun, null);
    assert.equal(orphans.stale, true);

    const others = status.filter((s) => s.job !== 'storage_orphans');
    for (const o of others) assert.equal(o.stale, null, 'and only the declared job is judged');
  });

  it('records a run, with what it scanned and what it did', async () => {
    const fl = await scenario();
    await fl.collectUploadReservations({ dryRun: true });

    const status = await fl.jobStatus();
    const res = status.find((s) => s.job === 'upload_reservations')!;
    assert.ok(res.lastRun, 'the run left a row');
    assert.equal(res.lastRun.outcome, 'ok');
    assert.equal(res.lastRun.mode, 'dry', 'and says it changed nothing');
    assert.equal(typeof res.lastRun.scanned, 'number');
    assert.equal(typeof res.lastRun.acted, 'number');
    assert.ok(res.ageSeconds !== null && res.ageSeconds >= 0);
  });

  it('records a DRY run as dry, so six weeks of them do not read as sweeping', async () => {
    const fl = await scenario();
    // Both sweepers DEFAULT to dry, which is the trap: an operator who passes
    // nothing has been doing nothing, successfully, for as long as they like.
    await fl.collectUploadReservations();
    const status = await fl.jobStatus();
    // Text and not a boolean: this schema has no boolean columns, which is how
    // P1's "there is no `public` flag" is enforced rather than stated. `'dry'`
    // also reads correctly here, where `false` would need the polarity recalled.
    assert.equal(status.find((s) => s.job === 'upload_reservations')!.lastRun!.mode, 'dry');
  });

  it('records a FAILED run and rethrows the original error', async () => {
    const fl = await scenario();
    // THE NaN HAZARD THE SOURCE DOCUMENTS, which is the honest failure to use
    // here: `Number(process.env.GC_GRACE)` on a misspelled variable is NaN,
    // TypeScript does not survive the process boundary, and the engine refuses
    // rather than computing a cutoff of NaN and deleting objects written
    // milliseconds ago.
    //
    // My first draft used "an adapter that cannot list" and it did not reject:
    // `quickstart()`'s MemoryStorage is a Map and lists perfectly well. I
    // assumed a limitation the code does not have.
    await assert.rejects(
      () => fl.collectStorageOrphans({ olderThanSeconds: Number.NaN }),
      /invalid_argument/,
    );

    const status = await fl.jobStatus();
    const orphans = status.find((s) => s.job === 'storage_orphans')!;
    assert.ok(orphans.lastRun, 'a failure is a run, and leaves a row');
    assert.equal(orphans.lastRun.outcome, 'failed');
    assert.ok(orphans.lastRun.error, 'with the reason');
    assert.equal(orphans.lastRun.scanned, null, 'and no counts, because nothing was scanned');
  });

  it('distinguishes a stale success from a recent failure', async () => {
    const fl = await scenario();
    await assert.rejects(
      () => fl.collectStorageOrphans({ olderThanSeconds: Number.NaN }),
      /invalid_argument/,
    );
    await fl.collectUploadReservations();

    const status = await fl.jobStatus({
      staleAfter: { storage_orphans: 86_400, upload_reservations: 86_400 },
    });
    const orphans = status.find((s) => s.job === 'storage_orphans')!;
    const res = status.find((s) => s.job === 'upload_reservations')!;

    // Both ran minutes ago, so neither is stale -- and one of them is broken.
    // "Not stale" is not "fine", which is why `outcome` is reported separately
    // rather than folded into a single health flag.
    assert.equal(orphans.stale, false);
    assert.equal(orphans.lastRun!.outcome, 'failed');
    assert.equal(res.stale, false);
    assert.equal(res.lastRun!.outcome, 'ok');
  });

  it('records a seal, and whether it actually sealed anything', async () => {
    const fl = await scenario();
    const orgId = (await fl.ids.orgId('acme'))!;
    await fl.sealAuditChain(orgId, 'nightly');
    // `jobStatus()` is deployment-wide on purpose -- see the note on the
    // method. The per-tenant question goes through `auditReader`, which
    // authorizes.

    const status = await fl.jobStatus();
    const seal = status.find((s) => s.job === 'audit_seal')!;
    assert.ok(seal.lastRun);
    assert.equal(seal.lastRun.outcome, 'ok');
    // Creating the org is audited, so there IS a chain to seal here.
    assert.equal(seal.lastRun.acted, 1);
    assert.equal(seal.lastRun.detail['sealed'], true);
  });

  it('is append-only: a failed run cannot be deleted', async () => {
    const fl = await scenario();
    await assert.rejects(
      () => fl.collectStorageOrphans({ olderThanSeconds: Number.NaN }),
      /invalid_argument/,
    );

    // The rule rewrites the DELETE to nothing rather than raising, exactly as
    // `audit_checkpoint` does. A failed run that can be removed is a failed run
    // that gets removed by whoever it embarrasses.
    await fl.store.db.query(`DELETE FROM job_run`);
    const status = await fl.jobStatus();
    assert.ok(
      status.find((s) => s.job === 'storage_orphans')!.lastRun,
      'the row survived the delete',
    );
  });
});
