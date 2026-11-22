/**
 * THE HIDDEN FUNCTIONAL BATTERY.
 *
 * Every check reads REQUIREMENTS.md and openapi.yaml and nothing else: it
 * speaks HTTP to a running implementation and never looks at its code, its
 * database or its bucket. A run is "functionally complete" only if every
 * check passes. The agent never sees this file; it sees smoke/smoke.mjs.
 *
 * Each check builds its own world (client.mjs), so no check depends on
 * another's leftovers.
 */
import { buildWorld, tokenOf } from './client.mjs';
import { CHECK_MS, bounded } from './bounds.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString('base64');

class Fail extends Error {}
const expect = (cond, detail) => {
  if (!cond) throw new Fail(detail);
};
const status = (r, want, what) =>
  expect(r.status === want, `${what}: expected ${want}, got ${r.status} ${r.text.slice(0, 160)}`);
const isErrorJson = (r) => r.json && typeof r.json.error === 'string';

async function share(c, w, opts = {}, as = w.alice, doc = w.docA) {
  const r = await c.call('POST', `/orgs/${w.orgA}/documents/${doc}/shares`, {
    as, body: { expiresInSeconds: 3600, ...opts },
  });
  status(r, 201, 'create share');
  return { id: r.json.id, token: tokenOf(r.json.url), url: r.json.url, expiresAt: r.json.expiresAt };
}
const redeem = (c, token, password) =>
  c.call('GET', `/s/${token}`, { headers: password === undefined ? {} : { 'x-share-password': password } });

const deliveryHeaders = (r, contentType, what) => {
  expect((r.headers['content-type'] ?? '').startsWith(contentType), `${what}: Content-Type is ${r.headers['content-type']}`);
  expect(/^attachment/i.test(r.headers['content-disposition'] ?? ''), `${what}: Content-Disposition is ${r.headers['content-disposition']}`);
  expect((r.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff', `${what}: no nosniff`);
  const cc = (r.headers['cache-control'] ?? '').toLowerCase();
  expect(/no-store/.test(cc) && /private/.test(cc), `${what}: Cache-Control is "${cc}"`);
};

export const CHECKS = [
  ['F01', 'users: register, duplicate email, invalid body', async (c) => {
    const email = `u.${Math.random().toString(36).slice(2)}@example.test`;
    const r = await c.call('POST', '/users', { body: { email } });
    status(r, 201, 'register');
    expect(typeof r.json?.id === 'string' && r.json.email === email, 'the body is not {id, email}');
    status(await c.call('POST', '/users', { body: { email } }), 409, 'duplicate email');
    status(await c.call('POST', '/users', { body: {} }), 400, 'no email');
  }],
  ['F02', 'orgs: identity required, creator is the owner', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('POST', '/orgs', { body: { name: 'X' } }), 401, 'no X-User-Id');
    status(await c.call('POST', '/orgs', { as: w.ghostUser, body: { name: 'X' } }), 401, 'unregistered id');
    status(await c.call('POST', '/orgs', { as: w.alice, body: {} }), 400, 'no name');
    const m = await c.call('GET', `/orgs/${w.orgA}/members`, { as: w.alice });
    status(m, 200, 'list members');
    const alice = (m.json?.members ?? []).find((x) => x.userId === w.alice);
    expect(alice?.role === 'owner', `the creator's role is ${alice?.role}`);
  }],
  ['F03', 'members: any member lists them, a stranger gets 404', async (c) => {
    const w = await buildWorld(c);
    const m = await c.call('GET', `/orgs/${w.orgA}/members`, { as: w.vera });
    status(m, 200, 'viewer lists members');
    expect((m.json?.members ?? []).length === 4, `expected 4 members, got ${(m.json?.members ?? []).length}`);
    status(await c.call('GET', `/orgs/${w.orgA}/members`, { as: w.eve }), 404, 'stranger lists members');
  }],
  ['F04', 'members: the owner adds and changes roles', async (c) => {
    const w = await buildWorld(c);
    const r = await c.call('PUT', `/orgs/${w.orgA}/members/${w.eve}`, { as: w.alice, body: { role: 'viewer' } });
    status(r, 200, 'add eve as viewer');
    expect(r.json?.userId === w.eve && r.json?.role === 'viewer', 'the body is not the membership');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.eve}`, { as: w.alice, body: { role: 'member' } }), 200, 'change to member');
    status(await c.call('GET', `/orgs/${w.orgA}/documents`, { as: w.eve }), 200, 'eve now lists Acme');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.eve}`, { as: w.alice, body: { role: 'boss' } }), 400, 'unknown role');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.ghostUser}`, { as: w.alice, body: { role: 'member' } }), 400, 'unregistered target');
  }],
  ['F05', 'members: what an admin may and may not do', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.mallory}`, { as: w.adam, body: { role: 'admin' } }), 200, 'admin makes a member admin');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.vera}`, { as: w.adam, body: { role: 'owner' } }), 403, 'admin makes someone owner');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.alice}`, { as: w.adam, body: { role: 'member' } }), 403, 'admin demotes the owner');
    status(await c.call('DELETE', `/orgs/${w.orgA}/members/${w.alice}`, { as: w.adam }), 403, 'admin removes the owner');
  }],
  ['F06', 'members: members and viewers change nothing', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.vera}`, { as: w.mallory, body: { role: 'member' } }), 403, 'member sets a role');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.mallory}`, { as: w.vera, body: { role: 'viewer' } }), 403, 'viewer sets a role');
    status(await c.call('DELETE', `/orgs/${w.orgA}/members/${w.vera}`, { as: w.mallory }), 403, 'member removes someone');
  }],
  ['F07', 'members: an org always keeps an owner', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.alice}`, { as: w.alice, body: { role: 'admin' } }), 409, 'last owner demotes themselves');
    status(await c.call('DELETE', `/orgs/${w.orgA}/members/${w.alice}`, { as: w.alice }), 409, 'last owner removes themselves');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.adam}`, { as: w.alice, body: { role: 'owner' } }), 200, 'a second owner');
    status(await c.call('PUT', `/orgs/${w.orgA}/members/${w.alice}`, { as: w.alice, body: { role: 'admin' } }), 200, 'now alice can step down');
  }],
  ['F08', 'members: a removed member loses access', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('DELETE', `/orgs/${w.orgA}/members/${w.mallory}`, { as: w.alice }), 204, 'owner removes mallory');
    status(await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.mallory }), 404, 'removed member reads');
    status(await c.call('DELETE', `/orgs/${w.orgA}/members/${w.mallory}`, { as: w.alice }), 404, 'remove a non-member');
  }],
  ['F09', 'documents: upload by role, the Document body', async (c) => {
    const w = await buildWorld(c);
    const r = await c.call('POST', `/orgs/${w.orgA}/documents`, {
      as: w.mallory, body: { name: 'm.bin', contentType: 'application/octet-stream', content: b64('12345') },
    });
    status(r, 201, 'member uploads');
    const d = r.json ?? {};
    expect(d.name === 'm.bin' && d.contentType === 'application/octet-stream' && d.size === 5 && d.uploadedBy === w.mallory
      && typeof d.id === 'string' && !Number.isNaN(Date.parse(d.createdAt)), `unexpected Document ${r.text.slice(0, 200)}`);
    status(await c.call('POST', `/orgs/${w.orgA}/documents`, { as: w.vera, body: { name: 'v', contentType: 'text/plain', content: b64('v') } }), 403, 'viewer uploads');
    status(await c.call('POST', `/orgs/${w.orgA}/documents`, { as: w.eve, body: { name: 'e', contentType: 'text/plain', content: b64('e') } }), 404, 'stranger uploads');
  }],
  ['F10', 'documents: upload validation and the 10 MiB limit', async (c) => {
    const w = await buildWorld(c);
    const up = (body) => c.call('POST', `/orgs/${w.orgA}/documents`, { as: w.alice, body });
    status(await up({ contentType: 'text/plain', content: b64('x') }), 400, 'no name');
    status(await up({ name: 'x', content: b64('x') }), 400, 'no contentType');
    status(await up({ name: 'x', contentType: 'text/plain', content: '***not base64***' }), 400, 'content is not base64');
    status(await up({ name: 'x', contentType: 'text/plain', content: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }), 413, 'over 10 MiB');
  }],
  ['F11', 'documents: list, newest first, for every role', async (c) => {
    const w = await buildWorld(c);
    const newest = await w.upload(w.mallory, w.orgA, 'n.txt', 'text/plain', 'n');
    const r = await c.call('GET', `/orgs/${w.orgA}/documents`, { as: w.vera });
    status(r, 200, 'viewer lists');
    const ids = (r.json?.documents ?? []).map((d) => d.id);
    expect(ids.length === 3 && ids[0] === newest && ids.includes(w.docA) && ids.includes(w.docA2), `listed ${JSON.stringify(ids)}`);
  }],
  ['F12', 'documents: download serves the bytes with the delivery headers', async (c) => {
    const w = await buildWorld(c);
    const r = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.vera });
    status(r, 200, 'viewer downloads');
    expect(r.text === 'DOC-A-SECRET', `the body is ${r.text.slice(0, 40)}`);
    deliveryHeaders(r, 'text/plain', 'download');
  }],
  ['F13', 'documents: a non-ASCII name survives in the header', async (c) => {
    const w = await buildWorld(c);
    const name = 'informe año 2026 “final”.pdf';
    const doc = await w.upload(w.alice, w.orgA, name, 'application/pdf', '%PDF-1.4');
    const r = await c.call('GET', `/orgs/${w.orgA}/documents/${doc}`, { as: w.alice });
    status(r, 200, 'download');
    const cd = r.headers['content-disposition'] ?? '';
    expect(cd.includes(encodeURIComponent(name)) || cd.includes(name), `Content-Disposition is ${cd}`);
  }],
  ['F14', 'documents: another org, a missing id and an unseen one look alike', async (c) => {
    const w = await buildWorld(c);
    const foreign = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.eve });
    const missing = await c.call('GET', `/orgs/${w.orgA}/documents/${w.ghostDoc}`, { as: w.alice });
    const ownRoute = await c.call('GET', `/orgs/${w.orgB}/documents/${w.docA}`, { as: w.eve });
    status(foreign, 404, 'stranger reads');
    status(missing, 404, 'missing id');
    const otherShape = await c.call('GET', `/orgs/${w.orgA}/documents/${w.ghostDocOtherShape}`, { as: w.alice });
    status(otherShape, 404, 'a missing id of another shape');
    expect(isErrorJson(otherShape), 'the other-shape refusal is not {error}');
    status(ownRoute, 404, "another org's document on your own org's route");
    expect(foreign.text === ownRoute.text, 'the two refusals have different bodies');
    expect(isErrorJson(foreign) && isErrorJson(missing), 'an error body is not {error}');
  }],
  ['F15', 'documents: who may delete, and what deletion does', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('DELETE', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.mallory }), 403, "member deletes someone else's");
    status(await c.call('DELETE', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.vera }), 403, 'viewer deletes');
    const own = await w.upload(w.mallory, w.orgA, 'own.txt', 'text/plain', 'own');
    status(await c.call('DELETE', `/orgs/${w.orgA}/documents/${own}`, { as: w.mallory }), 204, 'member deletes their own');
    const s = await share(c, w);
    status(await c.call('DELETE', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.adam }), 204, "admin deletes alice's");
    status(await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.alice }), 404, 'read after delete');
    status(await redeem(c, s.token), 404, 'share link after delete');
    const ids = ((await c.call('GET', `/orgs/${w.orgA}/documents`, { as: w.alice })).json?.documents ?? []).map((d) => d.id);
    expect(!ids.includes(w.docA) && !ids.includes(own), 'a deleted document is still listed');
  }],
  ['F16', 'shares: create, by role, and the CreatedShare body', async (c) => {
    const w = await buildWorld(c);
    const r = await c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.mallory, body: { expiresInSeconds: 600 } });
    status(r, 201, "member shares alice's document");
    expect(typeof r.json?.id === 'string' && r.json.url?.startsWith(`${c.baseUrl}/s/`), `the url is ${r.json?.url}`);
    const exp = Date.parse(r.json.expiresAt);
    expect(Math.abs(exp - (Date.now() + 600_000)) < 60_000, `expiresAt is ${r.json.expiresAt}`);
    expect(tokenOf(r.json.url).length >= 22, 'the token is too short to hold 128 bits');
    status(await c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.vera, body: { expiresInSeconds: 600 } }), 403, 'viewer shares');
    status(await c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.eve, body: { expiresInSeconds: 600 } }), 404, 'stranger shares');
  }],
  ['F17', 'shares: validation', async (c) => {
    const w = await buildWorld(c);
    const mk = (body) => c.call('POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.alice, body });
    status(await mk({}), 400, 'no expiresInSeconds');
    status(await mk({ expiresInSeconds: 0 }), 400, 'expiresInSeconds 0');
    status(await mk({ expiresInSeconds: 604801 }), 400, 'expiresInSeconds over a week');
    status(await mk({ expiresInSeconds: 1.5 }), 400, 'a fractional expiry');
    status(await mk({ expiresInSeconds: 60, maxDownloads: 0 }), 400, 'maxDownloads 0');
    status(await mk({ expiresInSeconds: 60, password: '' }), 400, 'an empty password');
  }],
  ['F18', 'shares: a link downloads the bytes with the delivery headers', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w);
    const r = await redeem(c, s.token);
    status(r, 200, 'redeem');
    expect(r.text === 'DOC-A-SECRET', 'the link served other bytes');
    deliveryHeaders(r, 'text/plain', 'share download');
    status(await redeem(c, 'x'.repeat(43)), 404, 'an unknown token');
  }],
  ['F19', 'shares: a password, and a wrong one consumes nothing', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w, { password: 'open-sesame', maxDownloads: 1 });
    status(await redeem(c, s.token), 401, 'no password');
    status(await redeem(c, s.token, 'wrong'), 401, 'wrong password');
    status(await redeem(c, s.token, 'open-sesame'), 200, 'right password after wrong ones');
    status(await redeem(c, s.token, 'open-sesame'), 404, 'past the cap');
  }],
  ['F20', 'shares: the download cap and the count', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w, { maxDownloads: 2 });
    status(await redeem(c, s.token), 200, 'first');
    status(await redeem(c, s.token), 200, 'second');
    status(await redeem(c, s.token), 404, 'third');
    const list = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.alice });
    const row = (list.json?.shares ?? []).find((x) => x.id === s.id);
    expect(row?.downloadCount === 2 && row?.maxDownloads === 2, `the listing says ${JSON.stringify(row)}`);
  }],
  ['F21', 'shares: expiry', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w, { expiresInSeconds: 1 });
    await sleep(Math.max(0, Date.parse(s.expiresAt) - Date.now()) + 1200);
    status(await redeem(c, s.token), 404, 'after expiry');
  }],
  ['F22', 'shares: who may revoke, and revocation is immediate', async (c) => {
    const w = await buildWorld(c);
    const mine = await share(c, w, {}, w.mallory);
    const alices = await share(c, w);
    status(await redeem(c, mine.token), 200, 'before revocation');
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${alices.id}`, { as: w.mallory }), 403, "member revokes someone else's");
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${mine.id}`, { as: w.vera }), 403, 'viewer revokes');
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${mine.id}`, { as: w.mallory }), 204, 'member revokes their own');
    status(await redeem(c, mine.token), 404, 'after revocation');
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${mine.id}`, { as: w.mallory }), 204, 'revoke twice');
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${alices.id}`, { as: w.adam }), 204, "admin revokes alice's");
    status(await c.call('DELETE', `/orgs/${w.orgA}/shares/${alices.id}`, { as: w.eve }), 404, 'stranger revokes');
  }],
  ['F23', 'shares: the listing never shows a token, a URL or a password', async (c) => {
    const w = await buildWorld(c);
    const s = await share(c, w, { password: 'hunter2-hunter2', maxDownloads: 5 });
    await c.call('DELETE', `/orgs/${w.orgA}/shares/${s.id}`, { as: w.alice });
    const r = await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.mallory });
    status(r, 200, 'member lists shares');
    expect(!r.text.includes(s.token) && !r.text.includes('hunter2-hunter2') && !r.text.includes('/s/'), 'the listing leaks a secret');
    const row = (r.json?.shares ?? []).find((x) => x.id === s.id);
    expect(row && row.revoked === true && row.hasPassword === true && row.documentId === w.docA && row.createdBy === w.alice,
      `the row is ${JSON.stringify(row)}`);
    status(await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}/shares`, { as: w.vera }), 403, 'viewer lists shares');
  }],
  ['F24', 'shares: one answer for every dead token', async (c) => {
    const w = await buildWorld(c);
    const revoked = await share(c, w);
    await c.call('DELETE', `/orgs/${w.orgA}/shares/${revoked.id}`, { as: w.alice });
    const capped = await share(c, w, { maxDownloads: 1 });
    await redeem(c, capped.token);
    const expiring = await share(c, w, { expiresInSeconds: 1 });
    await sleep(Math.max(0, Date.parse(expiring.expiresAt) - Date.now()) + 1200);
    const answers = await Promise.all([
      redeem(c, 'z'.repeat(43)), redeem(c, revoked.token), redeem(c, capped.token), redeem(c, expiring.token),
    ]);
    expect(answers.every((a) => a.status === 404), `statuses ${answers.map((a) => a.status)}`);
    expect(new Set(answers.map((a) => a.text)).size === 1, 'the bodies differ between dead tokens');
  }],
  ['F25', 'audit: who may read it, and what it holds', async (c) => {
    const w = await buildWorld(c);
    await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.mallory });
    const s = await share(c, w, {}, w.mallory);
    await redeem(c, s.token);
    await c.call('DELETE', `/orgs/${w.orgA}/shares/${s.id}`, { as: w.mallory });
    status(await c.call('GET', `/orgs/${w.orgA}/audit`, { as: w.mallory }), 403, 'member reads the audit');
    status(await c.call('GET', `/orgs/${w.orgA}/audit`, { as: w.eve }), 404, 'stranger reads the audit');
    const r = await c.call('GET', `/orgs/${w.orgA}/audit`, { as: w.adam });
    status(r, 200, 'admin reads the audit');
    const ev = r.json?.events ?? [];
    const has = (pred, what) => expect(ev.some(pred), `no ${what} in the org's audit`);
    has((e) => e.action === 'document.upload' && e.decision === 'allow' && e.documentId === w.docA && e.actorId === w.alice, 'upload of docA by alice');
    has((e) => e.action === 'document.read' && e.decision === 'allow' && e.documentId === w.docA && e.actorId === w.mallory, 'read of docA by mallory');
    has((e) => e.action === 'share.create' && e.decision === 'allow' && e.shareId === s.id, 'share.create');
    has((e) => e.action === 'share.download' && e.decision === 'allow' && e.shareId === s.id && (e.actorId ?? null) === null, 'anonymous share.download');
    has((e) => e.action === 'share.revoke' && e.decision === 'allow' && e.shareId === s.id, 'share.revoke');
    has((e) => e.action === 'member.set_role' && e.decision === 'allow', 'member.set_role');
    expect(ev.every((e) => e.orgId === w.orgA), "an event of another org, or of none, is in Acme's audit");
    const times = ev.map((e) => Date.parse(e.at));
    expect(times.every((t, i) => i === 0 || times[i - 1] >= t), 'the events are not newest first');
    const again = await c.call('GET', `/orgs/${w.orgA}/audit`, { as: w.adam });
    expect((again.json?.events ?? []).some((e) => e.action === 'audit.read' && e.actorId === w.adam), 'reading the audit is not recorded');
  }],
  ['F26', 'audit: denials are recorded', async (c) => {
    const w = await buildWorld(c);
    await c.call('GET', `/orgs/${w.orgA}/documents/${w.docA}`, { as: w.eve });
    await c.call('GET', `/orgs/${w.orgA}/documents/${w.ghostDoc}`, { as: w.eve });
    const s = await share(c, w, { password: 'pw-pw-pw' });
    await redeem(c, s.token, 'nope');
    const ghostToken = 'q'.repeat(43);
    await redeem(c, ghostToken);
    status(await c.call('POST', `/orgs/${w.orgA}/documents`, { as: w.vera, body: { name: 'v', contentType: 'text/plain', content: b64('v') } }), 403, 'viewer upload');
    const all = await c.adminAudit();
    const denied = (pred, what) => expect(all.some((e) => e.decision === 'deny' && typeof e.reason === 'string' && pred(e)), `no denial recorded for ${what}`);
    denied((e) => e.actorId === w.eve && e.documentId === w.docA, "eve's read of docA");
    denied((e) => e.actorId === w.eve && e.documentId === w.ghostDoc, "eve's read of a missing id");
    denied((e) => e.action === 'share.download' && e.shareId === s.id, 'a wrong password');
    denied((e) => e.action === 'share.download' && (e.orgId ?? null) === null && !e.shareId, 'an unknown token');
    denied((e) => e.action === 'document.upload' && e.actorId === w.vera, "the viewer's upload");
  }],
  ['F27', 'audit: the operator view needs the token and sees every org', async (c) => {
    const w = await buildWorld(c);
    status(await c.call('GET', '/admin/audit'), 401, 'no token');
    status(await c.call('GET', '/admin/audit', { headers: { 'x-admin-token': 'wrong' } }), 401, 'wrong token');
    const all = await c.adminAudit();
    expect(all.some((e) => e.orgId === w.orgA) && all.some((e) => e.orgId === w.orgB), 'the operator view lacks an org');
  }],
  ['F28', 'identity: an unregistered id is answered like a stranger', async (c) => {
    const w = await buildWorld(c);
    const stranger = await c.call('GET', `/orgs/${w.orgA}/documents`, { as: w.eve });
    const ghost = await c.call('GET', `/orgs/${w.orgA}/documents`, { as: w.ghostUser });
    status(stranger, 404, 'stranger lists');
    status(ghost, 404, 'unregistered id lists');
    expect(stranger.text === ghost.text, 'the two answers differ');
    status(await c.call('GET', `/orgs/${w.orgA}/documents`), 401, 'no X-User-Id');
  }],
  ['F29', 'robustness: malformed requests are 4xx, never 5xx', async (c) => {
    const w = await buildWorld(c);
    const bad = [
      ['POST', '/users', '{not json'],
      ['POST', '/orgs', '[]'],
      ['POST', `/orgs/${w.orgA}/documents`, '{"name": 5, "contentType": [], "content": {}}'],
      ['POST', `/orgs/${w.orgA}/documents/${w.docA}/shares`, '{"expiresInSeconds": "soon"}'],
      ['PUT', `/orgs/${w.orgA}/members/${w.vera}`, '{"role": null}'],
    ];
    for (const [m, p, body] of bad) {
      const r = await c.call(m, p, { as: w.alice, body, headers: { 'content-type': 'application/json' } });
      expect(r.status >= 400 && r.status < 500, `${m} ${p} with ${body} answered ${r.status}`);
      expect(isErrorJson(r), `${m} ${p}: the error body is not {error}`);
    }
    const weird = await c.call('GET', `/orgs/${w.orgA}/documents/${encodeURIComponent("'; DROP TABLE x; --")}`, { as: w.alice });
    expect(weird.status === 404, `a hostile id answered ${weird.status}`);
  }],
];

export async function runFunctional(makeClient) {
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

// Shared with the checks of the later tasks.
export { Fail, expect, status, share, redeem };
