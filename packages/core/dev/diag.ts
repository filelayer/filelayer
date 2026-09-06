/**
 * Standalone measurement of the authorization and audit defects listed in
 * `packages/core/CHANGELOG.md` under 0.2.0 and 0.3.0. Everything here is also
 * asserted in test/; this script exists so a reviewer can watch the behaviour
 * directly, in eleven lines of output, without reading a suite.
 *
 * It is written to run UNCHANGED against the pre-fix tree -- membership is
 * inserted with SQL rather than through `addMember`, whose signature is itself
 * one of the fixes -- so the two columns below are a real before/after and not
 * two different programs.
 *
 * Run: npm run dev:findings (from the repository root)
 */

import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

const td = new TextDecoder();
const dec = (u: Uint8Array): string => td.decode(u);
const enc = (s: string) => new TextEncoder().encode(s);
const ok = async <T>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);

let seq = 0;

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage());
  const org = (
    await db.query<{ id: string }>(
      `INSERT INTO org (external_id) VALUES ($1) RETURNING id`,
      [`org-${seq++}`],
    )
  ).rows[0]!.id;
  const actor = async (role: string | null) => {
    const id = (
      await db.query<{ id: string }>(`INSERT INTO actor (external_id) VALUES ($1) RETURNING id`, [
        `a-${seq++}`,
      ])
    ).rows[0]!.id;
    if (role) {
      await db.query(`INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)`, [
        org,
        id,
        role,
      ]);
    }
    return id;
  };
  const owner = await actor('owner');
  const file = await fl.upload({ actorId: owner }, org, {
    name: 'confidential.pdf',
    contentType: 'application/pdf',
    body: enc('SECRET'),
  });
  return { db, fl, org, owner, file, actor };
}

const count = async (db: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, sql: string, p: unknown[] = []) =>
  Number((((await db.query(sql, p)).rows[0] ?? { c: 0 }) as { c: number }).c);

// does an enumeration sweep leave a trace anywhere?
{
  const { db, fl, actor } = await world();
  const stranger = await actor(null);
  const before = await count(db, `select count(*)::int c from audit_event`);
  for (let i = 0; i < 25; i++) await ok(fl.read({ actorId: stranger }, crypto.randomUUID()));
  const after = await count(db, `select count(*)::int c from audit_event`);
  console.log(`25 enumeration probes            -> ${after - before} audit events`);
}

// and a brute-force sweep against the credential itself?
{
  const { db, fl } = await world();
  const before = await count(db, `select count(*)::int c from audit_event`);
  for (let i = 0; i < 10; i++) await ok(fl.redeem(`forged-${i}`));
  const after = await count(db, `select count(*)::int c from audit_event`);
  console.log(`10 forged link secrets           -> ${after - before} audit events`);
}

// does 410-vs-404 distinguish a real file id from a fabricated one?
{
  const { db, fl, file, actor } = await world();
  const stranger = await actor(null);
  await db.query(`update file set expires_at = now() - interval '1 second' where id = $1`, [
    file.id,
  ]);
  const { authorize, toPublicError } = await import('../src/authz.ts');
  const real = await authorize(fl.store, { actorId: stranger }, file.id, 'read');
  const fake = await authorize(fl.store, { actorId: stranger }, crypto.randomUUID(), 'read');
  const st = (d: typeof real) => (d.allow ? 200 : toPublicError(d.reason).status);
  console.log(
    `real-but-expired file -> ${st(real)}, nonexistent -> ${st(fake)}` +
      `   [oracle: ${st(real) !== st(fake)}]`,
  );
}

// can the forensic fields be rewritten without breaking the chain?
{
  const { db, fl, org, file, actor } = await world();
  const stranger = await actor(null);
  await ok(fl.read({ actorId: stranger }, file.id));
  await db.query(`ALTER TABLE audit_event DISABLE RULE audit_no_update`);
  const id = (
    await db.query<{ id: number }>(
      `select id from audit_event where org_id=$1 and decision='deny' order by id limit 1`,
      [org],
    )
  ).rows[0]!.id;
  await db.query(
    `update audit_event set reason='routine_maintenance', ip='10.0.0.1',
            context='{"note":"nothing to see"}'::jsonb where id=$1`,
    [id],
  );
  const v = await fl.store.verifyAuditChain(org);
  console.log(`reason/ip/context rewritten      -> chain still valid: ${v.valid}`);
}

// can any org member read any file with no grant and no act of sharing?
{
  const { fl, file, actor } = await world();
  const viewer = await actor('viewer');
  const got = await ok(fl.read({ actorId: viewer }, file.id));
  console.log(`viewer reads another's file      -> ${got ? `"${dec(got.body)}"` : 'denied'}`);
}

// can a holder of {share} mint themselves {delete}?
{
  const { fl, owner, file, actor } = await world();
  const holder = await actor('viewer');
  await fl.share({ actorId: owner }, file.id, {
    subject: { type: 'actor', actorId: holder },
    capabilities: ['share'],
  });
  const minted = await ok(
    fl.share({ actorId: holder }, file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['read', 'write', 'delete', 'share'],
    }),
  );
  const destroyed = minted ? Boolean(await ok(fl.delete({ actorId: holder }, file.id))) : false;
  // The API path was already safe before the fix -- it was patched inside
  // `filelayer.share()`. What changed is WHERE the rule lives, and therefore
  // whether a second entry point inherits it.
  const authz = (await import('../src/authz.ts')) as Record<string, unknown>;
  const where =
    typeof authz['authorizeShare'] === 'function' ? 'engine + schema trigger' : 'filelayer.share()';
  console.log(
    `{share} holder minted {delete}   -> ${minted !== null}; destroyed: ${destroyed}; ` +
      `enforced in: ${where}`,
  );
}

// does a delegated grant survive revocation of its parent, at depth?
{
  const { db, fl, owner, file, actor } = await world();
  const grants: string[] = [];
  let issuer: { actorId: string } = { actorId: owner };
  for (let d = 0; d < 4; d++) {
    const holder = await actor(null);
    const g = await fl.share(issuer, file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['read', 'share'],
    });
    grants.push(g.grantId);
    issuer = { actorId: holder };
  }
  const liveBefore = await count(db, `select count(*)::int c from live_grant`);
  await fl.revoke({ actorId: owner }, grants[0]!);
  const liveAfter = await count(db, `select count(*)::int c from live_grant`);
  const revokedRows = await count(
    db,
    `select count(*)::int c from file_grant where revoked_at is not null`,
  );
  console.log(
    `chain of 4, root revoked         -> live grants ${liveBefore} -> ${liveAfter} ` +
      `(rows actually written: ${revokedRows})`,
  );
}

// can a link grant carry delete?
{
  const { fl, owner, file } = await world();
  const link = await ok(
    fl.share({ actorId: owner }, file.id, {
      subject: { type: 'link' },
      capabilities: ['read', 'delete'],
    }),
  );
  const destroyed = link
    ? Boolean((await ok(fl.delete({ actorId: null, linkSecret: link.secret! }, file.id))) !== null)
    : false;
  console.log(`link grant carrying delete       -> created: ${link !== null}`);
}

// can anyone make themselves owner of any org, and is it audited?
{
  const { db, fl, org, file, actor } = await world();
  const outsider = await actor(null);
  // Called both ways so the script runs against either tree.
  const added = await ok(
    (fl.addMember as unknown as (...a: unknown[]) => Promise<void>)(
      { actorId: outsider },
      org,
      outsider,
      'owner',
    ),
  ).then((r) => r !== null)
    .catch(() => false);
  const legacy =
    added ||
    (await ok(
      (fl.addMember as unknown as (...a: unknown[]) => Promise<void>)(org, outsider, 'owner'),
    ).then((r) => r !== null));
  const stolen = await ok(fl.read({ actorId: outsider }, file.id));
  const events = await count(
    db,
    `select count(*)::int c from audit_event where action like 'member%'`,
  );
  console.log(
    `outsider self-promoted: ${legacy}      -> read "${stolen ? dec(stolen.body) : ''}"; ` +
      `membership audit events: ${events}`,
  );
}

// is a cap-refused download audited?
{
  const { db, fl, org, owner, file } = await world();
  const share = await fl.share({ actorId: owner }, file.id, {
    subject: { type: 'link' },
    maxDownloads: 1,
  });
  await fl.redeem(share.secret!);
  const before = await count(db, `select count(*)::int c from audit_event where org_id=$1`, [org]);
  for (let i = 0; i < 5; i++) await ok(fl.redeem(share.secret!));
  const after = await count(db, `select count(*)::int c from audit_event where org_id=$1`, [org]);
  console.log(`5 cap-refused downloads          -> ${after - before} audit events`);
}

// does the download reservation signal denial with a row, or an absence?
{
  const { db, fl, owner, file } = await world();
  const share = await fl.share({ actorId: owner }, file.id, {
    subject: { type: 'link' },
    maxDownloads: 1,
  });
  await fl.redeem(share.secret!);
  const rows = (await db.query(`select granted, remaining from consume_download($1)`, [
    share.grantId,
  ])).rows;
  console.log(
    `refused consume_download         -> ${rows.length} row(s) ` +
      `${rows.length ? JSON.stringify(rows[0]) : '(a caller defaulting to true fails OPEN)'}`,
  );
}
