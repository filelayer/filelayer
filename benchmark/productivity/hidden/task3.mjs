/**
 * THE HIDDEN CHECK OF TASK 3: the seeded bug.
 *
 * The seeded references (reference/*-t3-bug) let a viewer create a share
 * link. Task 3 is complete only if this check passes AND the whole task-1
 * battery and the 21 attacks still pass: check.mjs --task 3 runs all of it.
 *
 * The database the snapshot is scored on is not empty. Before the snapshot
 * starts, check.mjs starts the run's own seeded reference on the same
 * database and bucket and builds a world with it (seedTask3), so documents
 * exist that were uploaded while the bug was live. T3-01 then checks those
 * documents as well as fresh ones. A fix that only stops the bug for new
 * uploads, and leaves the documents already uploaded exposed, fails it (cold
 * review, finding 5).
 */
import { buildWorld, tokenOf, withTimeout } from './client.mjs';
import { Fail, expect, status, share, redeem } from './functional.mjs';

/** Run against the seeded reference: the world whose documents predate the fix. */
export async function seedTask3(c) {
  const w = await buildWorld(c);
  return { orgA: w.orgA, alice: w.alice, adam: w.adam, mallory: w.mallory, vera: w.vera, docA: w.docA, docA2: w.docA2 };
}

async function viewerCannotShare(c, w, what) {
  const opts = [{}, { maxDownloads: 1 }, { password: 'pw-123456' }];
  for (const o of opts) {
    const r = await c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, {
      as: w.vera, body: { expiresInSeconds: 3600, ...o },
    });
    status(r, 403, `${what}: a viewer creates a share with ${JSON.stringify(o)}`);
    expect(!r.json?.url, `${what}: the refusal returned a URL`);
    const t = tokenOf(r.json?.url);
    if (t) status(await redeem(c, t), 404, `${what}: the link a refusal returned`);
  }
  const l = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.alice });
  status(l, 200, `${what}: list shares`);
  expect((l.json?.shares ?? []).every((s) => s.createdBy !== w.vera), `${what}: a share created by the viewer is listed`);
  const denied = (await c.adminAudit()).filter(
    (e) => e.action === 'share.create' && e.decision === 'deny' && e.actorId === w.vera && e.documentId === w.docA,
  );
  expect(denied.length >= opts.length, `${what}: ${denied.length} denied share.create events for the viewer`);
  // The roles that may share still can.
  for (const who of ['alice', 'adam', 'mallory']) await share(c, w, {}, w[who]);
}

export const CHECKS = [
  ['T3-01', 'a viewer cannot create a share link, on documents uploaded before the fix and after it, and the refusal is recorded',
    async (c, seed) => {
      if (seed) await viewerCannotShare(c, seed, 'a document uploaded while the bug was live');
      await viewerCannotShare(c, await buildWorld(c), 'a document uploaded after the fix');
    }],
];

export async function runTask3(makeClient, seed = null) {
  const results = [];
  for (const [id, name, fn] of CHECKS) {
    try {
      await withTimeout(fn(makeClient(), seed), 240_000, `check ${id}`);
      results.push({ id, name, pass: true, seeded: !!seed });
    } catch (e) {
      results.push({ id, name, pass: false, seeded: !!seed, detail: e instanceof Fail ? e.message : `error: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, of: results.length, allPassed: passed === results.length };
}
