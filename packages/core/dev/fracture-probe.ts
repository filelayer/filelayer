/**
 * FRACTURE PROBE -- Step 1 of the progressive-disclosure assessment.
 *
 * Question: can the current model serve the trivial case (a public avatar)
 * without a redesign? Four experiments, each answering one sub-question with a
 * measurement rather than an opinion. Nothing here changes the product; it is
 * run against the tree as it stands.
 *
 *   E1  What does the simple case cost TODAY, in API calls and developer lines?
 *   E2  Is `org_id NULLABLE` a safe way to make the org optional?
 *   E3  Is `public` expressible under P1 without a public boolean?
 *   E4  Does the actor/membership requirement have a cheap upsert path?
 *
 * Run: npm run dev:fracture (from the repository root)
 */

import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

const line = (s = '') => console.log(s);
const head = (s: string) => {
  line();
  line('='.repeat(78));
  line(s);
  line('='.repeat(78));
};

// -----------------------------------------------------------------------------
// E1 -- the simple case, today, with no new API
// -----------------------------------------------------------------------------
async function e1() {
  head('E1  Public avatar with the API as it stands today');
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://cdn.test' });

  let calls = 0;
  const t0 = performance.now();

  calls++; const uploader = await fl.createActor('svc_uploader');
  calls++; const org = await fl.createOrg('my-app', 'My App', { ownerActorId: uploader.id });
  calls++; const file = await fl.upload({ actorId: uploader.id }, org.id, {
    name: 'avatar.png',
    contentType: 'image/png',
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  calls++; await fl.share({ actorId: uploader.id }, file.id, { subject: { type: 'anonymous' } });

  const ms = performance.now() - t0;

  // Does an anonymous reader actually get it?
  const anon = await fl.read({ actorId: null }, file.id);
  line(`API calls before the first public byte : ${calls}`);
  line(`Concepts the developer must understand : actor, org, membership(implicit), upload, grant  = 5`);
  line(`Anonymous read works                   : ${anon.body.byteLength === 4}`);
  line(`Wall time (PGlite/WASM)                : ${ms.toFixed(1)} ms`);
  line();
  line('Developer-written lines for the same thing, counted as the benchmark counts them:');
  line('  const up  = await fl.createActor("svc_uploader");');
  line('  const org = await fl.createOrg("my-app", "My App", { ownerActorId: up.id });');
  line('  const f   = await fl.upload({ actorId: up.id }, org.id, { name, contentType, body });');
  line('  await fl.share({ actorId: up.id }, f.id, { subject: { type: "anonymous" } });');
  line('  -> 4 lines, 5 concepts, before you have a URL (you still have no URL).');
}

// -----------------------------------------------------------------------------
// E2 -- would a nullable org_id be safe?
// -----------------------------------------------------------------------------
//
// P3 is enforced by the composite FK  file_grant(file_id, org_id) -> file(id, org_id).
// SQL's default MATCH SIMPLE semantics say: if ANY column of a composite FK is
// NULL, the constraint is NOT CHECKED AT ALL. So the moment org_id becomes
// nullable, a NULL org_id turns the tenant-isolation FK off for that row.
// This experiment builds exactly that schema and tries to write the grant that
// P3 is supposed to make unrepresentable.
async function e2() {
  head('E2  Is a NULLABLE org_id a safe way to make the org optional?');
  const { db } = await createTestDb();

  // A minimal replica of the real tables, with the ONE change under test.
  await db.query(`
    CREATE TABLE t_file (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NULL,                       -- <== the proposed change
      UNIQUE (id, org_id)
    )`);
  await db.query(`
    CREATE TABLE t_grant (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid NOT NULL,
      org_id uuid NULL,                       -- <== the proposed change
      FOREIGN KEY (file_id, org_id) REFERENCES t_file (id, org_id)
    )`);

  const orgA = '11111111-1111-1111-1111-111111111111';
  const orgB = '22222222-2222-2222-2222-222222222222';
  const { rows: f } = await db.query<{ id: string }>(
    `INSERT INTO t_file (org_id) VALUES ($1) RETURNING id`, [orgA],
  );
  const fileId = f[0]!.id;

  // Control: the cross-tenant grant P3 forbids, with both columns present.
  let blocked = false;
  try {
    await db.query(`INSERT INTO t_grant (file_id, org_id) VALUES ($1,$2)`, [fileId, orgB]);
  } catch { blocked = true; }
  line(`grant(file in org A, org_id = org B)      -> rejected: ${blocked}   [P3 holding]`);

  // The bypass: same forbidden relationship, org_id left NULL.
  let nullBlocked = false;
  try {
    await db.query(`INSERT INTO t_grant (file_id, org_id) VALUES ($1, NULL)`, [fileId]);
  } catch { nullBlocked = true; }
  line(`grant(file in org A, org_id = NULL)       -> rejected: ${nullBlocked}   [P3 ${nullBlocked ? 'holding' : 'SILENTLY OFF'}]`);

  // And the worst version: a grant pointing at a file that does not exist at all.
  let ghostBlocked = false;
  try {
    await db.query(
      `INSERT INTO t_grant (file_id, org_id) VALUES ('99999999-9999-9999-9999-999999999999', NULL)`,
    );
  } catch { ghostBlocked = true; }
  line(`grant(file that does not exist, org NULL) -> rejected: ${ghostBlocked}   [referential integrity ${ghostBlocked ? 'holding' : 'SILENTLY OFF'}]`);
  line();
  line('MATCH SIMPLE (the SQL default) does not check a composite FK when any');
  line('column is NULL. A nullable org_id therefore does not "relax" P3 -- it');
  line('DELETES it for exactly the rows that opt out, with no error anywhere.');
}

// -----------------------------------------------------------------------------
// E3 -- is `public` expressible today, and does it keep P4?
// -----------------------------------------------------------------------------
async function e3() {
  head('E3  Is public expressible under P1 (no public boolean), and is it revocable?');
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://cdn.test' });
  const up = await fl.createActor('u');
  const org = await fl.createOrg('o', 'o', { ownerActorId: up.id });
  const file = await fl.upload({ actorId: up.id }, org.id, {
    name: 'a.png', contentType: 'image/png', body: new Uint8Array([1, 2, 3]),
  });

  const g = await fl.share({ actorId: up.id }, file.id, { subject: { type: 'anonymous' } });
  const before = await fl.read({ actorId: null }, file.id).then(() => true).catch(() => false);
  await fl.revoke({ actorId: up.id }, g.grantId);
  const after = await fl.read({ actorId: null }, file.id).then(() => true).catch(() => false);

  line(`anonymous read while grant is live  : ${before}`);
  line(`anonymous read after grant revoked  : ${after}      [P4: revocation beats the URL]`);
  line(`grant is a listable, auditable row  : ${(await fl.listGrants({ actorId: up.id }, file.id)).length} row(s)`);
  line();
  line('So "public" is already expressible with ZERO schema change. It costs one');
  line('extra API call today. That call is a candidate for a one-line ergonomic');
  line('(`{ public: true }`) that creates the same row -- P1 is preserved because');
  line('the row still exists, is still explicit, still revocable, still audited.');
}

// -----------------------------------------------------------------------------
// E4 -- can actor/org provisioning be made idempotent without schema change?
// -----------------------------------------------------------------------------
async function e4() {
  head('E4  Can actor/org/membership be auto-provisioned idempotently?');
  const { db } = await createTestDb();

  await db.query(`INSERT INTO org (external_id, name) VALUES ('app','app')`);
  let dupBlocked = false;
  try {
    await db.query(`INSERT INTO org (external_id, name) VALUES ('app','app')`);
  } catch { dupBlocked = true; }
  line(`second createOrg('app') throws today            : ${dupBlocked}`);

  // The conflict target is (project_id, external_id), not external_id. When the
  // index was globally unique, one application's 'acme' resolved to a different
  // application's org row in any shared database -- see schema.sql, PROJECT,
  // and the cross-project identity collision entry in CHANGELOG.md 0.3.0.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO org (external_id, name) VALUES ('app','app')
     ON CONFLICT (project_id, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
     RETURNING id`,
  );
  line(`ON CONFLICT upsert on (project, external_id)    : ${Boolean(rows[0]?.id)}`);
  line(`membership already has ON CONFLICT (org,actor)  : true  (addMember uses it)`);
  line();
  line('external_id is UNIQUE per PROJECT on both org and actor, so an');
  line('idempotent get-or-create is a query change, not a schema change --');
  line('and it can no longer resolve across customer applications.');
}

await e1();
await e2();
await e3();
await e4();
line();
line('done.');
