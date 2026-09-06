/**
 * End-to-end exercise of examples/vault over real HTTP.
 *
 * examples/vault/server.ts is the whole Vault integration, and it is short.
 * This test exists so that claim is verifiable rather than asserted: the file
 * is driven end to end here, including every security-relevant path.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestDb } from '../src/db.ts';
import { MemoryStorage } from '../src/storage.ts';
import { createVaultApp } from '../../../examples/vault/server.ts';

let server: Server;
let base: string;

before(async () => {
  const { db } = await createTestDb();
  server = createVaultApp(db, new MemoryStorage());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function call(
  method: string,
  path: string,
  opts: { actor?: string; body?: unknown } = {},
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.actor ? { 'x-actor-id': opts.actor } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* binary or empty body */
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

describe('examples/vault: the whole B2B document workspace scenario over HTTP', () => {
  it('runs the full Vault story end to end', async () => {
    // --- setup: two tenants, four people ------------------------------------
    // Actors come first, because an org is created together with its first
    // owner. There is no window in which an org exists with nobody in it.
    const cfo = (await call('POST', '/actors', { body: { externalId: 'cfo' } })).json.id;
    const staff = (await call('POST', '/actors', { body: { externalId: 'staff' } })).json.id;
    const auditorRole = (await call('POST', '/actors', { body: { externalId: 'auditor' } })).json.id;
    const rival = (await call('POST', '/actors', { body: { externalId: 'rival' } })).json.id;

    const acme = (
      await call('POST', '/orgs', {
        body: { externalId: 'acme', name: 'Acme', ownerActorId: cfo },
      })
    ).json.id;
    const initech = (
      await call('POST', '/orgs', { body: { externalId: 'initech', ownerActorId: rival } })
    ).json.id;

    // Membership changes are authorized like everything else: the org owner
    // may make them, and nobody else may.
    assert.equal(
      (
        await call('POST', `/orgs/${acme}/members`, {
          actor: cfo,
          body: { actorId: staff, role: 'member' },
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await call('POST', `/orgs/${acme}/members`, {
          actor: cfo,
          body: { actorId: auditorRole, role: 'viewer' },
        })
      ).status,
      204,
    );
    // A member of the org cannot promote themselves...
    assert.equal(
      (
        await call('POST', `/orgs/${acme}/members`, {
          actor: staff,
          body: { actorId: staff, role: 'owner' },
        })
      ).status,
      404,
    );
    // ...and neither can a rival tenant, nor an unauthenticated caller.
    assert.equal(
      (
        await call('POST', `/orgs/${acme}/members`, {
          actor: rival,
          body: { actorId: rival, role: 'owner' },
        })
      ).status,
      404,
    );
    assert.equal(
      (await call('POST', `/orgs/${acme}/members`, { body: { actorId: rival, role: 'owner' } }))
        .status,
      404,
    );

    // --- upload -------------------------------------------------------------
    // No `visibility` given, so the board deck is private to its owner and the
    // org's admins. This is the default.
    const up = await call('POST', `/orgs/${acme}/files`, {
      actor: cfo,
      body: {
        name: 'board-deck.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.from('BOARD DECK Q3').toString('base64'),
      },
    });
    assert.equal(up.status, 201);
    const fileId = up.json.id;

    // ...and a document that is genuinely for the whole workspace says so.
    const handbookId = (
      await call('POST', `/orgs/${acme}/files`, {
        actor: cfo,
        body: {
          name: 'handbook.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('EMPLOYEE HANDBOOK').toString('base64'),
          visibility: 'org',
        },
      })
    ).json.id;

    // --- per-role access ----------------------------------------------------
    assert.equal((await call('GET', `/files/${fileId}`, { actor: cfo })).text, 'BOARD DECK Q3');
    // The default really is deny: a member of the same org gets nothing.
    assert.equal((await call('GET', `/files/${fileId}`, { actor: staff })).status, 404);
    assert.equal((await call('GET', `/files/${fileId}`, { actor: auditorRole })).status, 404);
    assert.equal((await call('GET', `/files/${fileId}`, { actor: rival })).status, 404);
    assert.equal((await call('GET', `/files/${fileId}`)).status, 404);

    // The org-visible document behaves the way the old default did.
    assert.equal(
      (await call('GET', `/files/${handbookId}`, { actor: staff })).text,
      'EMPLOYEE HANDBOOK',
    );
    assert.equal(
      (await call('GET', `/files/${handbookId}`, { actor: auditorRole })).text,
      'EMPLOYEE HANDBOOK',
    );
    assert.equal((await call('GET', `/files/${handbookId}`, { actor: rival })).status, 404);

    // A viewer can read it but cannot delete or share it.
    assert.equal((await call('DELETE', `/files/${handbookId}`, { actor: auditorRole })).status, 404);
    assert.equal(
      (await call('POST', `/files/${handbookId}/shares`, { actor: auditorRole, body: {} })).status,
      404,
    );

    // --- the listing screen (R22) --------------------------------------------
    // The endpoint a security review found missing. Every assertion below is a
    // rule the application would otherwise have had to express in SQL.
    const listOf = async (actor?: string) =>
      (await call('GET', `/orgs/${acme}/files`, actor ? { actor } : {})).json.files.map(
        (f: any) => f.name,
      );

    // The CFO owns the private deck and the org-visible handbook: both.
    assert.deepEqual((await listOf(cfo)).sort(), ['board-deck.pdf', 'handbook.pdf']);
    // A member sees only the org-visible one. The private deck is not merely
    // unreadable, it is not enumerable.
    assert.deepEqual(await listOf(staff), ['handbook.pdf']);
    assert.deepEqual(await listOf(auditorRole), ['handbook.pdf']);
    // The rival tenant sees nothing, and gets a 200 with an empty page rather
    // than a 404 -- a 404 here would be an org-existence oracle.
    const rivalList = await call('GET', `/orgs/${acme}/files`, { actor: rival });
    assert.equal(rivalList.status, 200);
    assert.deepEqual(rivalList.json.files, []);
    assert.deepEqual(await listOf(), []); // anonymous
    // An org that does not exist is indistinguishable from one you cannot see.
    const ghost = await call('GET', `/orgs/00000000-0000-4000-8000-000000000000/files`, {
      actor: cfo,
    });
    assert.equal(ghost.status, 200);
    assert.deepEqual(ghost.json.files, []);

    // A grant makes a private file appear -- and revoking it makes it vanish.
    const direct = await call('POST', `/files/${fileId}/shares`, {
      actor: cfo,
      body: { actorId: staff },
    });
    assert.equal(direct.status, 201);
    assert.deepEqual((await listOf(staff)).sort(), ['board-deck.pdf', 'handbook.pdf']);
    assert.equal((await call('DELETE', `/shares/${direct.json.grantId}`, { actor: cfo })).status, 204);
    assert.deepEqual(await listOf(staff), ['handbook.pdf']);

    // Pagination is keyset and the order is total.
    const page1 = (await call('GET', `/orgs/${acme}/files?limit=1`, { actor: cfo })).json;
    assert.equal(page1.files.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = (
      await call('GET', `/orgs/${acme}/files?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, {
        actor: cfo,
      })
    ).json;
    assert.equal(page2.files.length, 1);
    assert.notEqual(page1.files[0].id, page2.files[0].id);
    assert.equal(page2.nextCursor, null);

    // --- authenticated read carries the security headers too -----------------
    const readRes = await call('GET', `/files/${handbookId}`, { actor: staff });
    assert.equal(readRes.headers.get('x-content-type-options'), 'nosniff');
    assert.match(readRes.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.match(readRes.headers.get('cache-control') ?? '', /no-store/);

    // --- share link with expiry + password + download cap --------------------
    const share = await call('POST', `/files/${fileId}/shares`, {
      actor: cfo,
      body: { expiresInHours: 24, maxDownloads: 2, password: 'boardroom' },
    });
    assert.equal(share.status, 201);
    const secret = share.json.secret;
    assert.ok(secret);

    assert.equal((await call('GET', `/d/${secret}`)).status, 401); // password required
    // A credential in the URL is now impossible rather than merely discouraged: a
    // credential in the query string is refused before any work is done, so it
    // cannot reach an access log, a proxy log or browser history. It also does
    // not consume a download.
    const inQuery = await call('GET', `/d/${secret}?password=boardroom`);
    assert.equal(inQuery.status, 400);
    assert.equal(inQuery.json.error, 'credential_in_query');
    assert.equal((await call('POST', `/d/${secret}`, { body: { password: 'nope' } })).status, 401);
    const dl1 = await call('POST', `/d/${secret}`, { body: { password: 'boardroom' } });
    assert.equal(dl1.status, 200);
    assert.equal(dl1.text, 'BOARD DECK Q3');

    // The library owns the response, so nosniff, no-store, an explicit
    // disposition and no-referrer are present on the share path without the
    // application naming any of them. That is the point of the route existing.
    assert.equal(dl1.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl1.headers.get('cache-control') ?? '', /no-store/);
    assert.match(dl1.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(dl1.headers.get('referrer-policy'), 'no-referrer');

    // --- listing what has been shared ---------------------------------------
    const allGrants = (await call('GET', `/files/${fileId}/shares`, { actor: cfo })).json;
    // Two: the revoked actor grant from the listing section above, and the link.
    // Revoked grants stay listed -- "what did we share, and is it still live" is
    // the question a compliance screen asks.
    assert.equal(allGrants.length, 2);
    const grants = allGrants.filter((g: any) => g.subjectType === 'link');
    assert.equal(grants.length, 1);
    assert.equal(grants[0].hasPassword, true);
    assert.equal(grants[0].downloadCount, 1);
    assert.equal(JSON.stringify(allGrants).includes(secret), false);

    // --- revocation beats the live URL --------------------------------------
    assert.equal((await call('DELETE', `/shares/${grants[0].id}`, { actor: cfo })).status, 204);
    assert.equal(
      (await call('POST', `/d/${secret}`, { body: { password: 'boardroom' } })).status,
      404,
    );

    // --- retention ----------------------------------------------------------
    const held = await call('POST', `/orgs/${acme}/files`, {
      actor: cfo,
      body: {
        name: 'signed-contract.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.from('CONTRACT').toString('base64'),
        retainForDays: 2555,
      },
    });
    assert.equal((await call('DELETE', `/files/${held.json.id}`, { actor: cfo })).status, 409);

    // --- audit trail --------------------------------------------------------
    const denials = (await call('GET', `/orgs/${acme}/audit?decision=deny`, { actor: cfo })).json;
    assert.ok(denials.length >= 3, `expected the denials to be recorded, got ${denials.length}`);
    assert.ok(denials.some((e: any) => e.reason === 'no_membership'));
    assert.ok(denials.some((e: any) => e.reason === 'retention_hold'));

    // A member cannot read the audit log.
    assert.equal((await call('GET', `/orgs/${acme}/audit`, { actor: staff })).status, 404);
    // Nor can the rival tenant.
    assert.equal((await call('GET', `/orgs/${acme}/audit`, { actor: rival })).status, 404);

    const integrity = (await call('GET', `/orgs/${acme}/audit-integrity`, { actor: cfo })).json;
    assert.equal(integrity.valid, true);
    assert.ok(integrity.checked > 5);
  });
});
