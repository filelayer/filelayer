#!/usr/bin/env node
/**
 * The smoke test every run can see. It walks the happy path once: register,
 * create an org, add a member, upload, list, download, share, download
 * through the link, revoke, read the audit trail.
 *
 * Passing it means the service is wired up. It checks none of the rules about
 * refusals, isolation, limits or headers: the hidden tests do.
 *
 *     node smoke.mjs http://127.0.0.1:3000
 */

const base = (process.argv[2] ?? process.env.BASE_URL ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: node smoke.mjs <base url>');
  process.exit(2);
}

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
  return ok;
}

async function call(method, path, { as, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(as ? { 'x-user-id': as } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* bytes */
  }
  return { status: res.status, json, bytes };
}

async function main() {
  const health = await call('GET', '/health');
  if (!check('GET /health is 200', health.status === 200, `got ${health.status}`)) return;

  const tag = Math.random().toString(36).slice(2, 10);
  const owner = await call('POST', '/users', { body: { email: `owner-${tag}@smoke.test` } });
  const member = await call('POST', '/users', { body: { email: `member-${tag}@smoke.test` } });
  if (!check('POST /users returns an id', owner.status === 201 && !!owner.json?.id && !!member.json?.id,
    `got ${owner.status}`)) return;
  const o = owner.json.id;
  const m = member.json.id;

  const org = await call('POST', '/orgs', { as: o, body: { name: 'Smoke Co' } });
  if (!check('POST /orgs returns an id', org.status === 201 && !!org.json?.id, `got ${org.status}`)) return;
  const orgId = org.json.id;

  const put = await call('PUT', `/orgs/${orgId}/members/${m}`, { as: o, body: { role: 'member' } });
  check('the owner adds a member', put.status === 200 || put.status === 201, `got ${put.status}`);

  const members = await call('GET', `/orgs/${orgId}/members`, { as: m });
  check('a member lists the members', members.status === 200 && Array.isArray(members.json?.members),
    `got ${members.status}`);

  const content = 'hello from the smoke test\n';
  const up = await call('POST', `/orgs/${orgId}/documents`, {
    as: m,
    body: { name: 'smoke.txt', contentType: 'text/plain', content: Buffer.from(content).toString('base64') },
  });
  if (!check('a member uploads a document', up.status === 201 && !!up.json?.id, `got ${up.status}`)) return;
  const docId = up.json.id;

  const list = await call('GET', `/orgs/${orgId}/documents`, { as: o });
  check('the owner lists it', list.status === 200 && (list.json?.documents ?? []).some((d) => d.id === docId),
    `got ${list.status}`);

  const get = await call('GET', `/orgs/${orgId}/documents/${docId}`, { as: o });
  check('the owner downloads the same bytes', get.status === 200 && get.bytes.toString() === content,
    `got ${get.status}`);

  const share = await call('POST', `/orgs/${orgId}/documents/${docId}/shares`, {
    as: m,
    body: { expiresInSeconds: 600 },
  });
  if (!check('a member creates a share link', share.status === 201 && !!share.json?.url && !!share.json?.id,
    `got ${share.status}`)) return;
  const path = new URL(share.json.url).pathname;

  const dl = await call('GET', path);
  check('anyone downloads through the link', dl.status === 200 && dl.bytes.toString() === content,
    `got ${dl.status}`);

  const shares = await call('GET', `/orgs/${orgId}/documents/${docId}/shares`, { as: m });
  check('the document\'s shares are listed', shares.status === 200 &&
    (shares.json?.shares ?? []).some((s) => s.id === share.json.id), `got ${shares.status}`);

  const rev = await call('DELETE', `/orgs/${orgId}/shares/${share.json.id}`, { as: m });
  check('its creator revokes it', rev.status === 204, `got ${rev.status}`);

  const after = await call('GET', path);
  check('the revoked link no longer works', after.status === 404, `got ${after.status}`);

  const audit = await call('GET', `/orgs/${orgId}/audit`, { as: o });
  check('the owner reads the audit trail', audit.status === 200 && (audit.json?.events ?? []).length > 0,
    `got ${audit.status}`);
}

main()
  .catch((e) => {
    check('the smoke test ran to the end', false, e.message);
  })
  .finally(() => {
    console.log(failed ? `smoke: ${failed} failed` : 'smoke: all passed');
    process.exitCode = failed ? 1 : 0;
  });
