/**
 * THE HIDDEN CHECKS OF TASK 2: revocation records a reason.
 *
 * They read prompts/task2-change.md and nothing else. Task 2 is complete only
 * if these pass AND the whole task-1 battery and the 21 attacks still pass:
 * check.mjs --task 2 runs all of it.
 */
import { buildWorld } from './client.mjs';
import { CHECK_MS, bounded } from './bounds.mjs';
import { Fail, expect, status, share, redeem } from './functional.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const revoke = (c, w, shareId, body, as = w.alice) =>
  c.call('DELETE', `/orgs/${w.orgA}/shares/${shareId}`, { as, ...(body === undefined ? {} : { body }) });
const listed = async (c, w, shareId, doc = w.docA) => {
  const r = await c.call('GET', `/orgs/${w.orgA}/documents/${doc}/shares`, { as: w.alice });
  status(r, 200, 'list shares');
  const s = (r.json?.shares ?? []).find((x) => x.id === shareId);
  expect(s, 'the share is not in the listing');
  return s;
};
const revokeEvents = async (c, shareId, decision = 'allow') =>
  (await c.adminAudit())
    .filter((e) => e.action === 'share.revoke' && e.shareId === shareId && e.decision === decision)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export const CHECKS = [
  ['T2-01', 'a reason is kept on the share and on the event', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    const before = await listed(c, w, s.id);
    expect('revokedAt' in before && before.revokedAt === null, `a live share has revokedAt ${JSON.stringify(before.revokedAt)}`);
    expect('revokeReason' in before && before.revokeReason === null, `a live share has revokeReason ${JSON.stringify(before.revokeReason)}`);
    status(await revoke(c, w, s.id, { reason: 'Contract ended' }), 204, 'revoke with a reason');
    status(await redeem(c, s.token), 404, 'the revoked link');
    const after = await listed(c, w, s.id);
    expect(after.revoked === true, 'revoked is not true');
    expect(isDate(after.revokedAt), `revokedAt is ${JSON.stringify(after.revokedAt)}`);
    expect(after.revokeReason === 'Contract ended', `revokeReason is ${JSON.stringify(after.revokeReason)}`);
    const ev = await revokeEvents(c, s.id);
    expect(ev.length === 1, `${ev.length} allowed share.revoke events`);
    expect(ev[0].revokeReason === 'Contract ended', `the event's revokeReason is ${JSON.stringify(ev[0].revokeReason)}`);
  }],
  ['T2-02', 'no body, or a body without reason, revokes with no reason', async (c) => {
    const w = await buildWorld(c);
    for (const body of [undefined, {}, { note: 'ignored' }]) {
      const s = await share(c, w);
      status(await revoke(c, w, s.id, body), 204, `revoke with ${JSON.stringify(body)}`);
      status(await redeem(c, s.token), 404, `the link revoked with ${JSON.stringify(body)}`);
      const l = await listed(c, w, s.id);
      expect(l.revoked === true && isDate(l.revokedAt), `with ${JSON.stringify(body)}: revoked ${l.revoked}, revokedAt ${l.revokedAt}`);
      expect(l.revokeReason === null, `with ${JSON.stringify(body)}: revokeReason is ${JSON.stringify(l.revokeReason)}`);
      const ev = await revokeEvents(c, s.id);
      expect(ev.length === 1 && ev[0].revokeReason === null,
        `with ${JSON.stringify(body)}: events ${JSON.stringify(ev.map((e) => e.revokeReason))}`);
    }
  }],
  ['T2-03', 'a reason that is not 1 to 200 characters is 400 and revokes nothing', async (c) => {
    const w = await buildWorld(c);
    const bad = ['', 'x'.repeat(201), 42, null, true, ['a'], { text: 'a' }];
    for (const reason of bad) {
      const s = await share(c, w);
      const r = await revoke(c, w, s.id, { reason });
      status(r, 400, `reason ${JSON.stringify(reason).slice(0, 40)}`);
      expect(r.json && typeof r.json.error === 'string', `reason ${JSON.stringify(reason).slice(0, 40)}: the error body is not {error}`);
      status(await redeem(c, s.token), 200, `the link after reason ${JSON.stringify(reason).slice(0, 40)}`);
      const l = await listed(c, w, s.id);
      expect(l.revoked === false && l.revokedAt === null && l.revokeReason === null,
        `after reason ${JSON.stringify(reason).slice(0, 40)}: ${JSON.stringify(l)}`);
    }
  }],
  ['T2-04', 'a reason of exactly 1 and exactly 200 characters is accepted', async (c) => {
    const w = await buildWorld(c);
    for (const reason of ['x', 'y'.repeat(200)]) {
      const s = await share(c, w);
      status(await revoke(c, w, s.id, { reason }), 204, `a reason of ${reason.length}`);
      const l = await listed(c, w, s.id);
      expect(l.revokeReason === reason, `a reason of ${reason.length} came back as ${JSON.stringify(l.revokeReason).slice(0, 40)}`);
    }
  }],
  ['T2-05', 'a second revocation is recorded, but the listing keeps the first', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    status(await revoke(c, w, s.id, { reason: 'first' }), 204, 'first revoke');
    const first = await listed(c, w, s.id);
    await sleep(1100);
    status(await revoke(c, w, s.id, { reason: 'second' }, w.adam), 204, 'second revoke');
    const again = await listed(c, w, s.id);
    expect(again.revokeReason === 'first', `the listing's revokeReason became ${JSON.stringify(again.revokeReason)}`);
    expect(again.revokedAt === first.revokedAt, `revokedAt moved from ${first.revokedAt} to ${again.revokedAt}`);
    const ev = await revokeEvents(c, s.id);
    expect(ev.length === 2, `${ev.length} allowed share.revoke events, expected 2`);
    expect(ev[0].revokeReason === 'first' && ev[1].revokeReason === 'second',
      `the events carry ${JSON.stringify(ev.map((e) => e.revokeReason))}`);
  }],
  ['T2-06', 'a reason given after a revocation without one does not fill it in', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    status(await revoke(c, w, s.id), 204, 'first revoke, no reason');
    status(await revoke(c, w, s.id, { reason: 'late' }), 204, 'second revoke');
    const l = await listed(c, w, s.id);
    expect(l.revokeReason === null, `revokeReason became ${JSON.stringify(l.revokeReason)}`);
  }],
  ['T2-07', 'a refused revocation stores nothing about its reason', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    status(await revoke(c, w, s.id, { reason: 'by mallory' }, w.mallory), 403, 'a member revokes a share they did not create');
    status(await revoke(c, w, s.id, { reason: 'by vera' }, w.vera), 403, 'a viewer revokes');
    const live = await listed(c, w, s.id);
    expect(live.revoked === false && live.revokeReason === null, `after the refusals: ${JSON.stringify(live)}`);
    status(await redeem(c, s.token), 200, 'the link after the refusals');
    const denied = await revokeEvents(c, s.id, 'deny');
    expect(denied.length >= 2, `${denied.length} denied share.revoke events`);
    expect(denied.every((e) => e.revokeReason == null), `a denial carries ${JSON.stringify(denied.map((e) => e.revokeReason))}`);
    status(await revoke(c, w, s.id), 204, 'the creator revokes, no reason');
    const l = await listed(c, w, s.id);
    expect(l.revokeReason === null, `the refused reason surfaced: ${JSON.stringify(l.revokeReason)}`);
  }],
  ['T2-08', 'every other event has revokeReason null, and the org trail shows it too', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    await redeem(c, s.token);
    status(await revoke(c, w, s.id, { reason: 'shown in the org trail' }), 204, 'revoke');
    const all = await c.adminAudit();
    // Only an allowed share.revoke may carry a reason; the trail holds the
    // events of every earlier check too, so this looks at all of them.
    const others = all.filter((e) => !(e.action === 'share.revoke' && e.decision === 'allow'));
    const leaked = others.filter((e) => e.revokeReason != null);
    expect(leaked.length === 0, `${leaked.length} other events carry a revokeReason, e.g. ${JSON.stringify(leaked[0])}`);
    const org = await c.call('GET', `/orgs/${w.orgA}/audit?limit=1000`, { as: w.alice });
    status(org, 200, 'org audit');
    const mine = (org.json?.events ?? []).filter((e) => e.action === 'share.revoke' && e.shareId === s.id && e.decision === 'allow');
    expect(mine.length === 1 && mine[0].revokeReason === 'shown in the org trail',
      `the org trail shows ${JSON.stringify(mine.map((e) => e.revokeReason))}`);
  }],
];

export async function runTask2(makeClient) {
  const results = [];
  for (const [id, name, fn] of CHECKS) {
    try {
      await bounded(CHECK_MS, `check ${id}`, (signal) => fn(makeClient(signal)));
      results.push({ id, name, pass: true });
    } catch (e) {
      results.push({ id, name, pass: false, detail: e instanceof Fail ? e.message : `error: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, of: results.length, allPassed: passed === results.length };
}
