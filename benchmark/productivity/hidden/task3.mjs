/**
 * THE HIDDEN CHECK OF TASK 3: the seeded bug.
 *
 * The seeded references (reference/*-t3-bug) let a viewer create a share
 * link. Task 3 is complete only if this check passes AND the whole task-1
 * battery and the 21 attacks still pass: check.mjs --task 3 runs all of it.
 */
import { buildWorld, tokenOf } from './client.mjs';
import { Fail, expect, status, share, redeem } from './functional.mjs';

export const CHECKS = [
  ['T3-01', 'a viewer cannot create a share link, and the refusal is recorded', async (c) => {
    const w = await buildWorld(c);
    const opts = [{}, { maxDownloads: 1 }, { password: 'pw-123456' }];
    for (const o of opts) {
      const r = await c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, {
        as: w.vera, body: { expiresInSeconds: 3600, ...o },
      });
      status(r, 403, `a viewer creates a share with ${JSON.stringify(o)}`);
      expect(!r.json?.url, 'the refusal returned a URL');
      const t = tokenOf(r.json?.url);
      if (t) status(await redeem(c, t), 404, 'the link a refusal returned');
    }
    const l = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.alice });
    status(l, 200, 'list shares');
    expect((l.json?.shares ?? []).every((s) => s.createdBy !== w.vera), 'a share created by the viewer is listed');
    const denied = (await c.adminAudit()).filter(
      (e) => e.action === 'share.create' && e.decision === 'deny' && e.actorId === w.vera,
    );
    expect(denied.length >= opts.length, `${denied.length} denied share.create events for the viewer`);
    // The roles that may share still can.
    for (const who of ['alice', 'adam', 'mallory']) await share(c, w, {}, w[who]);
  }],
];

export async function runTask3(makeClient) {
  const results = [];
  for (const [id, name, fn] of CHECKS) {
    try {
      await fn(makeClient());
      results.push({ id, name, pass: true });
    } catch (e) {
      results.push({ id, name, pass: false, detail: e instanceof Fail ? e.message : `error: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, of: results.length, allPassed: passed === results.length };
}
