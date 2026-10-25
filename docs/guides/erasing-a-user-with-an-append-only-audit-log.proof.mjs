#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `erasing-a-user-with-an-append-only-audit-log.md`,
 * REPRODUCIBLE.
 *
 *     node docs/guides/erasing-a-user-with-an-append-only-audit-log.proof.mjs
 *
 * It needs no server running and nothing installed beyond this repository's
 * own dependencies: `embedded-postgres` starts a real PostgreSQL as an
 * ordinary user process. A real one, because every claim here is about what
 * the SERVER does — a rule, a referential integrity trigger, a window
 * function — and a mock has none of them.
 *
 * -----------------------------------------------------------------------------
 * THE DIGEST IS THE LIBRARY'S, NOT A SIMPLIFIED ONE
 * -----------------------------------------------------------------------------
 *
 * An earlier draft of this script hashed `[prev, action, decision]` while the
 * page beside it made claims about which FIELDS the chain protects. The two
 * agreed with each other and both disagreed with the shipped code, and the
 * page passed every gate in the repository. So the digest below is the one
 * `auditHashTail()` builds, field for field, and step 5 depends on it.
 *
 * What it demonstrates, in order:
 *
 *   1. THE TRAP. An append-only rule makes a tenant with any audit history
 *      undeletable, and the error message says why in a line most quotes of
 *      it leave out.
 *   1b. THE SAME RULE WITH `WHERE true` DELETES FINE AND LEAVES ORPHANS. This
 *      is the step that identifies the mechanism: it is not that the rows
 *      survived, it is that the rewrite left no statement to run.
 *   1c. A TRIGGER instead of a rule is worse: silent, with orphans.
 *   2. The rule's DELETE is silent, so an erasure script reports success and
 *      removes nothing.
 *   3. Removing one person's scattered events without attestation breaks the
 *      chain, and replay says so.
 *   4. The same removal with one checkpoint PER CONTIGUOUS RUN verifies, with
 *      every hole reported as attested.
 *   5. The digest covers the identity, so an edit to `actor_id` is detected —
 *      and that is exactly why redaction-in-place is unavailable here.
 *   6. The limits, asserted rather than claimed: a checkpoint is forgeable
 *      from a value sitting in the next surviving row, and `removed_count` is
 *      not verified by replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54398;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const dir = await mkdtemp(join(tmpdir(), 'filelayer-erasure-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL (every claim here is the server\'s)... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const db = new pg.Client({
  connectionString: `postgres://postgres:postgres@localhost:${PORT}/proof`,
});
await db.connect();

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

const fails = async (sql, params = []) => {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return { message: e.message, hint: e.hint ?? null };
  }
};

// --- the schema, reduced but not simplified where it matters -----------------

const build = async () => {
  await db.query(`DROP TABLE IF EXISTS audit_checkpoint, audit_event, org CASCADE`);
  await db.query(`CREATE TABLE org (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
  await db.query(`
    CREATE TABLE audit_event (
        id          bigserial PRIMARY KEY,
        org_id      uuid REFERENCES org(id) ON DELETE CASCADE,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        action      text NOT NULL,
        decision    text NOT NULL,
        reason      text,
        actor_id    text,
        file_id     text,
        prev_hash   text,
        hash        text NOT NULL
    )`);
  await db.query(`
    CREATE TABLE audit_checkpoint (
        id               bigserial PRIMARY KEY,
        org_id           uuid,
        kind             text NOT NULL CHECK (kind IN ('trim', 'seal')),
        through_event_id bigint NOT NULL,
        through_hash     text NOT NULL,
        removed_count    bigint NOT NULL DEFAULT 0,
        note             text NOT NULL
    )`);
};

/**
 * `auditHashTail()`, field for field. `prevHash` is the first element of the
 * array for the reason the library gives: it lets the database concatenate it
 * in one statement without duplicating the encoding in SQL.
 */
const digest = (prev, e) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        prev, e.orgId, e.occurredAt, e.action, e.decision, e.reason ?? null,
        e.actorId, e.fileId ?? null, null, null, null, '{}',
      ]),
      'utf8',
    )
    .digest('hex');

let ORG;
const append = async (e, org = ORG) => {
  // PER-ORG CHAINING, which the published query depends on and an earlier
  // version of this script did not do. A chain that links across tenants
  // makes the `WHERE org_id = $1` in that query compute the wrong runs, and
  // the reader finds out during an erasure.
  const { rows } = await db.query(
    `SELECT hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
    [org],
  );
  const prev = rows[0]?.hash ?? null;
  const occurredAt = new Date().toISOString();
  const full = { ...e, orgId: org, occurredAt };
  await db.query(
    `INSERT INTO audit_event (org_id, occurred_at, action, decision, reason,
                              actor_id, file_id, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [org, occurredAt, e.action, e.decision, e.reason ?? null, e.actorId,
     e.fileId ?? null, prev, digest(prev, full)],
  );
};

const replay = async (org = ORG) => {
  const { rows } = await db.query(
    `SELECT id, org_id, occurred_at, action, decision, reason, actor_id, file_id,
            prev_hash, hash
       FROM audit_event WHERE org_id = $1 ORDER BY id`,
    [org],
  );
  const { rows: cps } = await db.query(
    `SELECT through_hash FROM audit_checkpoint WHERE kind = 'trim' AND org_id = $1`,
    [org],
  );
  const attestedBy = new Set(cps.map((c) => c.through_hash));
  let prev = null;
  let attestedGaps = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev) {
      if (!attestedBy.has(r.prev_hash)) {
        return { valid: false, brokenAt: Number(r.id), attestedGaps, problem: 'gap' };
      }
      attestedGaps++;
    }
    const want = digest(r.prev_hash, {
      orgId: r.org_id,
      occurredAt: r.occurred_at.toISOString(),
      action: r.action,
      decision: r.decision,
      reason: r.reason,
      actorId: r.actor_id,
      fileId: r.file_id,
    });
    if (want !== r.hash) {
      return { valid: false, brokenAt: Number(r.id), attestedGaps, problem: 'edited' };
    }
    prev = r.hash;
  }
  return { valid: true, checked: rows.length, attestedGaps };
};

/**
 * TWO TENANTS, INTERLEAVED, because one tenant cannot show what this page
 * claims.
 *
 * With a single org, position-in-chain and `id` are the same number, so
 * grouping the doomed events by raw id-adjacency gives the same answer as
 * grouping them by chain position and the page's central design claim is
 * untestable. An earlier version of this script seeded one org and therefore
 * validated that claim against the one input where it cannot fail.
 *
 * Acme's chain is `e, o, e, e, o, e, o`; a second tenant's events land
 * BETWEEN them, so acme's ids are 1,3,5,7,9,11,13 and no two of erika's are
 * adjacent in id terms even where they are adjacent in the chain.
 */
let OTHER_ORG;
const seed = async () => {
  await build();
  ORG = (await db.query(`INSERT INTO org (name) VALUES ('acme') RETURNING id`)).rows[0].id;
  OTHER_ORG = (await db.query(`INSERT INTO org (name) VALUES ('globex') RETURNING id`)).rows[0].id;
  await db.query(`CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING`);
  await db.query(`CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING`);
  for (const who of ['erika', 'other', 'erika', 'erika', 'other', 'erika', 'other']) {
    await append({ action: 'file.read', decision: 'allow', actorId: who, fileId: 'f1' });
    await append({ action: 'file.read', decision: 'allow', actorId: 'zoe', fileId: 'g1' },
                  OTHER_ORG);
  }
};

await seed();
console.log(`seeded 7 events: erika's four are INTERLEAVED, not a prefix\n`);

// ---------------------------------------------------------------------------
console.log('1. the tenant that cannot be deleted');
// ---------------------------------------------------------------------------
{
  const e = await fails(`DELETE FROM org WHERE id = $1`, [ORG]);
  console.log(`   DELETE FROM org                        ${e ? 'REFUSED' : 'succeeded'}`);
  console.log(`   ERROR: ${e?.message ?? '(none)'}`);
  console.log(`   HINT:  ${e?.hint ?? '(none)'}`);
  expect(e !== null, 'the org deleted, so this schema does not have the trap');
  expect(/referential integrity query/i.test(e?.message ?? ''), 'refused by something else');
  expect(
    /rule/i.test(e?.hint ?? ''),
    'no HINT naming a rule — then the page must not claim Postgres says so',
  );
  console.log('   -> The HINT names the cause. Quotes of this error that stop at');
  console.log('      the ERROR line manufacture a mystery Postgres already solved.\n');
}

// ---------------------------------------------------------------------------
console.log('1b. the same rule with WHERE true: no error, and orphans');
// ---------------------------------------------------------------------------
{
  // THE STEP THAT IDENTIFIES THE MECHANISM. If the refusal above were caused
  // by the rows surviving and the foreign key still being violated, this would
  // refuse too: same rule, same semantics, rows still survive. It does not.
  // The RI trigger compares the RESULT CODE of the statement it ran through
  // SPI; an unconditional DO INSTEAD NOTHING leaves nothing to run, a
  // conditional one leaves a statement that runs and affects no rows.
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  await db.query(
    `CREATE RULE audit_no_delete AS ON DELETE TO audit_event WHERE true DO INSTEAD NOTHING`,
  );
  const e = await fails(`DELETE FROM org WHERE id = $1`, [ORG]);
  const orphans = Number(
    (await db.query(`SELECT count(*)::text n FROM audit_event WHERE org_id = $1`, [ORG])).rows[0].n,
  );
  const orgGone =
    Number((await db.query(`SELECT count(*)::text n FROM org WHERE id = $1`, [ORG])).rows[0].n) === 0;
  console.log(`   DELETE FROM org                        ${e ? 'REFUSED' : 'SUCCEEDED'}`);
  console.log(`   the org row is gone                    ${orgGone}`);
  console.log(`   audit rows left pointing at it         ${orphans}`);
  expect(e === null, 'the conditional rule refused too, so the mechanism is not the rewrite');
  expect(orgGone && orphans > 0, 'no orphans, so this did not demonstrate the difference');
  console.log('   -> One word changes a loud error into silent corruption. The');
  console.log('      refusal above is about the REWRITE, not about the rows.\n');
}

// ---------------------------------------------------------------------------
console.log('1c. a trigger instead of a rule: silent, and also orphans');
// ---------------------------------------------------------------------------
{
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  await db.query(`
    CREATE FUNCTION no_delete() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
  await db.query(`
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION no_delete()`);
  const e = await fails(`DELETE FROM org WHERE id = $1`, [ORG]);
  const orphans = Number(
    (await db.query(`SELECT count(*)::text n FROM audit_event WHERE org_id = $1`, [ORG])).rows[0].n,
  );
  console.log(`   DELETE FROM org                        ${e ? 'REFUSED' : 'SUCCEEDED'}`);
  console.log(`   audit rows left pointing at it         ${orphans}`);
  expect(e === null && orphans > 0, 'the trigger behaved like the rule');
  await db.query(`DROP TRIGGER audit_no_delete ON audit_event`);
  await db.query(`DROP FUNCTION no_delete()`);
  console.log('   -> The implementation PostgreSQL steers you towards fails the');
  console.log('      other way: no error at all, and a dangling audit trail.\n');
}

// ---------------------------------------------------------------------------
console.log('2. and the rule is SILENT about what it suppressed');
// ---------------------------------------------------------------------------
{
  await seed();
  const before = Number((await db.query(`SELECT count(*)::text n FROM audit_event`)).rows[0].n);
  const r = await db.query(`DELETE FROM audit_event WHERE actor_id = 'erika'`);
  const after = Number((await db.query(`SELECT count(*)::text n FROM audit_event`)).rows[0].n);
  console.log(`   DELETE ... WHERE actor_id = 'erika'    reported ${r.rowCount} row(s)`);
  console.log(`   rows actually removed                  ${before - after}`);
  expect(r.rowCount === 0 && before === after, 'the rule did not hold');
  console.log('   -> No error. An erasure script that catches exceptions reports');
  console.log('      success and erases nothing, which is the worst outcome here.\n');
}

// ---------------------------------------------------------------------------
console.log('3. removing her scattered events, with nothing to account for it');
// ---------------------------------------------------------------------------
{
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  await db.query(`DELETE FROM audit_event WHERE actor_id = 'erika'`);
  const v = await replay();
  console.log(`   replay after an unattested removal     valid=${v.valid} brokenAt=${v.brokenAt}`);
  expect(v.valid === false, 'an unattested gap was forgiven');
  console.log('   -> Correct, and useless to you: the log says it was tampered');
  console.log('      with, and the tamperer was your own lawful erasure job.\n');
}

// ---------------------------------------------------------------------------
console.log('4. the same removal, one checkpoint per CONTIGUOUS RUN');
// ---------------------------------------------------------------------------
{
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  await db.query('BEGIN');
  // Gaps and islands over the CHAIN's ordering: the difference between a row's
  // position in the chain and its position among the doomed is constant within
  // a run and changes at every break.
  const runs = await db.query(
    `WITH chain AS (
       SELECT id, hash, actor_id, row_number() OVER (ORDER BY id) AS chain_rn
         FROM audit_event WHERE org_id = $1
     ), doomed AS (
       SELECT id, hash, chain_rn - row_number() OVER (ORDER BY id) AS run
         FROM chain WHERE actor_id = $2
     )
     SELECT (array_agg(id   ORDER BY id DESC))[1]::text AS last_id,
            (array_agg(hash ORDER BY id DESC))[1]       AS last_hash,
            count(*)::text                              AS n
       FROM doomed GROUP BY run ORDER BY min(id)`,
    [ORG, 'erika'],
  );
  const removed = (await db.query(`DELETE FROM audit_event WHERE actor_id = 'erika'`)).rowCount;
  for (const r of runs.rows) {
    await db.query(
      `INSERT INTO audit_checkpoint (org_id, kind, through_event_id, through_hash,
                                     removed_count, note)
       VALUES ($1,'trim',$2,$3,$4,$5)`,
      [ORG, Number(r.last_id), r.last_hash, Number(r.n), 'erasure request, ticket 4471'],
    );
  }
  await db.query('COMMIT');

  const v = await replay();
  console.log(`   events removed                         ${removed}`);
  console.log(`   contiguous runs, so checkpoints        ${runs.rows.length}`);
  console.log(`   the other tenant's chain               ${(await replay(OTHER_ORG)).valid ? 'untouched' : 'BROKEN'}`);
  console.log(`   replay                                 valid=${v.valid} checked=${v.checked}`);
  console.log(`   holes, and whether they are accounted  attestedGaps=${v.attestedGaps}`);
  const survivors = Number(
    (
      await db.query(
        `SELECT count(*)::text n FROM audit_event WHERE org_id = $1 AND actor_id <> 'erika'`,
        [ORG],
      )
    ).rows[0].n,
  );
  console.log(`   everyone else's events                 ${survivors}, untouched`);
  expect(v.valid === true, 'a correctly attested erasure failed to verify');
  expect(v.attestedGaps === runs.rows.length, 'a hole was made that no checkpoint accounts for');
  expect(runs.rows.length < removed, 'adjacency was not collapsed: a checkpoint per event');
  expect(survivors === 3, `expected 3 surviving events, got ${survivors}`);
  expect((await replay(OTHER_ORG)).valid === true, "the other tenant's chain was damaged");
  console.log('   -> Four events, three holes, because two of hers were adjacent.');
  console.log('      `attestedGaps` is not zero and must not be: this history is');
  console.log('      shorter than what happened, by a recorded amount.\n');
}

// ---------------------------------------------------------------------------
console.log('4b. the same query grouped by raw id adjacency, which is wrong');
// ---------------------------------------------------------------------------
{
  // THE COMPARISON THE PAGE CLAIMED AND DID NOT RUN. With two tenants
  // interleaved, this tenant's events are non-contiguous in id terms even
  // where they are adjacent in its chain, so grouping on id splits every run.
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  const byId = await db.query(
    `WITH doomed AS (
       SELECT id, hash, id - row_number() OVER (ORDER BY id) AS run
         FROM audit_event WHERE org_id = $1 AND actor_id = $2
     )
     SELECT count(*)::text AS n FROM (SELECT run FROM doomed GROUP BY run) g`,
    [ORG, 'erika'],
  );
  const byChain = await db.query(
    `WITH chain AS (
       SELECT id, actor_id, row_number() OVER (ORDER BY id) AS chain_rn
         FROM audit_event WHERE org_id = $1
     ), doomed AS (
       SELECT id, chain_rn - row_number() OVER (ORDER BY id) AS run
         FROM chain WHERE actor_id = $2
     )
     SELECT count(*)::text AS n FROM (SELECT run FROM doomed GROUP BY run) g`,
    [ORG, 'erika'],
  );
  const nId = Number(byId.rows[0].n);
  const nChain = Number(byChain.rows[0].n);
  console.log(`   runs found by chain position           ${nChain}`);
  console.log(`   runs found by raw id adjacency         ${nId}`);
  expect(nChain === 3, `expected 3 chain runs, got ${nChain}`);
  expect(nId > nChain, 'id grouping gave the same answer, so this comparison proves nothing');
  console.log(`   -> ${nId - nChain} extra checkpoint(s), each one a row nothing will ever`);
  console.log('      consume. With a single tenant these two numbers are equal,');
  console.log('      which is why a one-tenant fixture cannot test this claim.\n');
}

// ---------------------------------------------------------------------------
console.log('5. why redaction-in-place is unavailable: the digest covers identity');
// ---------------------------------------------------------------------------
{
  await seed();
  await db.query(`DROP RULE audit_no_update ON audit_event`);
  const before = await replay();
  expect(before.valid === true, 'the seeded chain did not verify');
  await db.query(`UPDATE audit_event SET actor_id = NULL WHERE actor_id = 'erika'`);
  const v = await replay();
  console.log(`   blank the personal column, keep hashes valid=${v.valid} problem=${v.problem}`);
  expect(v.valid === false && v.problem === 'edited', 'an identity edit went undetected');
  console.log('   -> The remedy every write-up recommends is detected as tampering');
  console.log('      HERE, and that is not a defect: a log you can redact per');
  console.log('      subject is a log whose identity fields were never protected.\n');
}

// ---------------------------------------------------------------------------
console.log('6. what a checkpoint does NOT prove');
// ---------------------------------------------------------------------------
{
  // (a) forgeable: the value a checkpoint must carry is sitting in plaintext
  //     in the prev_hash of the first surviving row after the hole.
  await seed();
  await db.query(`DROP RULE audit_no_delete ON audit_event`);
  // This tenant's own chain positions, because ids are shared with the other
  // tenant now. Remove its 2nd and 3rd events and forge a checkpoint from the
  // `prev_hash` the 4th still carries.
  const acme = (
    await db.query(`SELECT id FROM audit_event WHERE org_id = $1 ORDER BY id`, [ORG])
  ).rows.map((r) => Number(r.id));
  await db.query(`DELETE FROM audit_event WHERE id = ANY($1::bigint[])`, [[acme[1], acme[2]]]);
  const orphanPrev = (
    await db.query(`SELECT prev_hash FROM audit_event WHERE id = $1`, [acme[3]])
  ).rows[0].prev_hash;
  await db.query(
    `INSERT INTO audit_checkpoint (org_id, kind, through_event_id, through_hash,
                                   removed_count, note)
     VALUES ($1,'trim',$2,$3,$4,$5)`,
    [ORG, acme[2], orphanPrev, 1, 'forged'],
  );
  const v = await replay();
  console.log(`   a checkpoint forged from the next row  valid=${v.valid}`);
  expect(v.valid === true, 'the forgery did not work, so this limit is overstated');
  console.log(`   it claims removed_count                1, and 2 were removed`.replace('2 were', `${2} were`));
  console.log('   -> Replay never reads `removed_count`, and the hash it matches');
  console.log('      on is readable by anyone who can see the table. A checkpoint');
  console.log('      records INTENT, which is worth having, and proves nothing');
  console.log('      about scale. `audit_checkpoint` needs the same append-only');
  console.log('      protection as `audit_event`, and the page says so.\n');
}

await db.end();
await server.stop();
await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every claim in the guide reproduced.'
    : `${failures} claim(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
