#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `tamper-evident-file-audit.md`, REPRODUCIBLE.
 *
 * The guide beside this file makes claims about what a hash chain detects, what
 * it does NOT detect, and what two concurrent writers do to it. The last one is
 * the reason this needs a real PostgreSQL rather than an in-process engine:
 * ONE BACKEND CANNOT FORK A CHAIN, so on a single-backend database the broken
 * two-statement append and the correct single-statement one look identical.
 *
 *     node docs/guides/tamper-evident-file-audit.proof.mjs
 *
 * What it demonstrates, in order:
 *
 *   1. Append-only: UPDATE and DELETE are rewritten to nothing SILENTLY -- the
 *      statement reports success and zero rows -- and TRUNCATE goes straight
 *      through the rules until a statement-level trigger stops it.
 *   2. The three things replay catches: an edited event, an event removed from
 *      the middle, the first event removed.
 *   3. THE ONE IT DOES NOT CATCH: the most recent events removed. `valid: true`
 *      over a shorter history. This is the limitation the guide leads with, and
 *      it is measured rather than asserted.
 *   4. The fork. Fifty concurrent writers through the two-statement append, and
 *      fifty through the single-statement function, on a real server.
 *   5. A trim without a checkpoint is indistinguishable from tampering. The
 *      same trim WITH one verifies, and reports the gap.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54392;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const dir = await mkdtemp(join(tmpdir(), 'filelayer-audit-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL (one backend cannot fork a chain)... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const URL = `postgres://postgres:postgres@localhost:${PORT}/proof`;
const admin = new pg.Client({ connectionString: URL });
await admin.connect();
await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

const ORG = '22222222-2222-2222-2222-222222222222';

// ---------------------------------------------------------------------------
// The schema from the guide.
// ---------------------------------------------------------------------------

await admin.query(`
  CREATE TABLE audit_event (
      id          bigserial PRIMARY KEY,
      org_id      uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      action      text NOT NULL,
      decision    text NOT NULL CHECK (decision IN ('allow', 'deny')),
      prev_hash   text,
      hash        text NOT NULL
  )`);

await admin.query(`
  CREATE TABLE audit_checkpoint (
      id            bigserial PRIMARY KEY,
      org_id        uuid,
      kind          text NOT NULL CHECK (kind IN ('trim', 'seal')),
      created_at    timestamptz NOT NULL DEFAULT now(),
      through_id    bigint NOT NULL,
      through_hash  text NOT NULL,
      removed_count integer NOT NULL DEFAULT 0,
      removed_from  bigint,
      removed_to    bigint,
      note          text,
      CONSTRAINT checkpoint_seal_removes_nothing CHECK (
          kind <> 'seal' OR (removed_count = 0 AND removed_from IS NULL AND removed_to IS NULL)
      )
  )`);
await admin.query('CREATE INDEX audit_checkpoint_hash_idx ON audit_checkpoint (through_hash)');

await admin.query(`
  CREATE FUNCTION audit_chain_lock_key(p_org_id uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE AS $$
      SELECT (hashtext('myapp.audit_chain')::bigint << 32)
           | (hashtext(coalesce(p_org_id::text, '__system__'))::bigint & x'ffffffff'::bigint);
  $$`);

/** The single-statement append from the guide. */
await admin.query(`
  CREATE FUNCTION audit_append(
      p_org_id uuid, p_action text, p_decision text, p_hash_tail text
  ) RETURNS TABLE (id bigint, prev_hash text, hash text)
  LANGUAGE plpgsql AS $$
  DECLARE v_prev text; v_hash text;
  BEGIN
      PERFORM pg_advisory_xact_lock(audit_chain_lock_key(p_org_id));

      SELECT a.hash INTO v_prev
        FROM audit_event a
       WHERE a.org_id IS NOT DISTINCT FROM p_org_id
       ORDER BY a.id DESC LIMIT 1;

      v_hash := encode(digest(convert_to(
          '[' || coalesce(to_json(v_prev)::text, 'null') || ',' || p_hash_tail, 'utf8'
      ), 'sha256'), 'hex');

      RETURN QUERY
      INSERT INTO audit_event (org_id, action, decision, prev_hash, hash)
           VALUES (p_org_id, p_action, p_decision, v_prev, v_hash)
        RETURNING audit_event.id, audit_event.prev_hash, audit_event.hash;
  END;
  $$`);

/**
 * The canonical digest input, in application code. `prev_hash` is element
 * zero deliberately: everything after it is what the caller serializes and
 * hands to the function as `p_hash_tail`, so there is one encoding and not two.
 *
 * `tail` keeps the CLOSING bracket and drops the opening one, because the SQL
 * side supplies `'['`, the predecessor and a comma, and nothing else. Getting
 * that off by one byte is a chain that never verifies and a long afternoon.
 */
const tail = (action, decision) => JSON.stringify([action, decision]).slice(1);
const digest = (prev, action, decision) =>
  createHash('sha256').update(JSON.stringify([prev, action, decision])).digest('hex');

/** Replay in application code, which is the independent implementation. */
async function verify(orgId) {
  const { rows } = await admin.query(
    `SELECT id, action, decision, prev_hash, hash FROM audit_event
      WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY id ASC`,
    [orgId],
  );
  let prev = null;
  let attestedGaps = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev) {
      // Before calling it tampering, look for an attestation that accounts
      // for the gap: a checkpoint whose head IS the prev_hash we were handed.
      const { rows: cp } = await admin.query(
        `SELECT removed_count FROM audit_checkpoint
          WHERE org_id IS NOT DISTINCT FROM $1 AND kind = 'trim' AND through_hash = $2`,
        [orgId, r.prev_hash],
      );
      if (cp.length === 0) {
        return { valid: false, problem: 'prev_hash_mismatch', brokenAt: Number(r.id), attestedGaps };
      }
      attestedGaps += Number(cp[0].removed_count);
    }
    if (digest(r.prev_hash, r.action, r.decision) !== r.hash) {
      return { valid: false, problem: 'hash_mismatch', brokenAt: Number(r.id), attestedGaps };
    }
    prev = r.hash;
  }
  const last = rows.at(-1) ?? null;
  return {
    valid: true,
    attestedGaps,
    checked: rows.length,
    lastId: last ? Number(last.id) : null,
    lastHash: last ? last.hash : null,
  };
}

async function append(client, orgId, action, decision = 'allow') {
  const { rows } = await client.query('SELECT * FROM audit_append($1, $2, $3, $4)', [
    orgId,
    action,
    decision,
    tail(action, decision),
  ]);
  return rows[0];
}

/** Rebuild a clean chain of n events and return it. */
async function freshChain(n, orgId = ORG) {
  await admin.query('DELETE FROM audit_event');
  await admin.query('DELETE FROM audit_checkpoint');
  const out = [];
  for (let i = 0; i < n; i++) out.push(await append(admin, orgId, `file.read.${i}`));
  return out;
}

// ---------------------------------------------------------------------------
console.log('1. append-only, and exactly how far it goes');
// ---------------------------------------------------------------------------
{
  await freshChain(3);
  await admin.query('CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING');
  await admin.query('CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING');

  const u = await admin.query(`UPDATE audit_event SET action = 'tampered'`);
  const d = await admin.query('DELETE FROM audit_event');
  console.log(`   UPDATE every row    rowCount ${u.rowCount}   error: none`);
  console.log(`   DELETE every row    rowCount ${d.rowCount}   error: none`);
  expect(u.rowCount === 0 && d.rowCount === 0, 'the rules did not rewrite the statements');
  const n = (await admin.query('SELECT count(*) AS c FROM audit_event')).rows[0].c;
  expect(Number(n) === 3, 'rows were lost');
  console.log('   -> both succeeded and did nothing. A caller who thinks they');
  console.log('      trimmed the log is not told otherwise.');

  await admin.query('TRUNCATE audit_event');
  const after = (await admin.query('SELECT count(*) AS c FROM audit_event')).rows[0].c;
  console.log(`   TRUNCATE, rules in place   rows left ${after}`);
  expect(Number(after) === 0, 'TRUNCATE did not go through the rules');

  await admin.query(`
    CREATE FUNCTION audit_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit_event is append-only: TRUNCATE is refused'; END; $$`);
  await admin.query(`
    CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate()`);
  await freshChain(3);
  let refused = null;
  try {
    await admin.query('TRUNCATE audit_event');
  } catch (e) {
    refused = String(e.message);
  }
  console.log(`   TRUNCATE, trigger added    ${refused ?? 'ACCEPTED'}`);
  expect(refused !== null, 'the TRUNCATE trigger did not fire');
  console.log('   -> rules are per-DML-statement-type. TRUNCATE is not DML.\n');
}

// ---------------------------------------------------------------------------
console.log('2. the three things replay catches');
// ---------------------------------------------------------------------------
{
  // The rules are in place, so tamper the way a determined operator would:
  // drop them first. That is the point -- they are not a privilege boundary.
  const unprotect = async () => {
    await admin.query('DROP RULE IF EXISTS audit_no_update ON audit_event');
    await admin.query('DROP RULE IF EXISTS audit_no_delete ON audit_event');
  };
  await unprotect();

  let chain = await freshChain(5);
  expect((await verify(ORG)).valid, 'a freshly built chain did not verify');

  await admin.query(`UPDATE audit_event SET action = 'file.read.ZZZ' WHERE id = $1`, [chain[2].id]);
  let v = await verify(ORG);
  console.log(`   an event edited                 valid ${v.valid}  ${v.problem} at id ${v.brokenAt}`);
  expect(!v.valid && v.problem === 'hash_mismatch' && v.brokenAt === Number(chain[2].id),
    'an edit was not located at the edited row');

  chain = await freshChain(5);
  await admin.query('DELETE FROM audit_event WHERE id = $1', [chain[2].id]);
  v = await verify(ORG);
  console.log(`   an event removed from the middle valid ${v.valid}  ${v.problem} at id ${v.brokenAt}`);
  expect(!v.valid && v.problem === 'prev_hash_mismatch' && v.brokenAt === Number(chain[3].id),
    'a middle deletion was not caught at the successor');

  chain = await freshChain(5);
  await admin.query('DELETE FROM audit_event WHERE id = $1', [chain[0].id]);
  v = await verify(ORG);
  console.log(`   the FIRST event removed          valid ${v.valid}  ${v.problem} at id ${v.brokenAt}`);
  expect(!v.valid && v.problem === 'prev_hash_mismatch' && v.brokenAt === Number(chain[1].id),
    'removing the head of the chain was not caught');
  console.log('   -> all three located, at the row where the chain stops adding up.\n');
}

// ---------------------------------------------------------------------------
console.log('3. the one replay CANNOT catch');
// ---------------------------------------------------------------------------
{
  const chain = await freshChain(5);
  const before = await verify(ORG);
  await admin.query('DELETE FROM audit_event WHERE id >= $1', [chain[3].id]);
  const after = await verify(ORG);
  console.log(`   before                           valid ${before.valid}  checked ${before.checked}  head id ${before.lastId}`);
  console.log(`   last two events deleted          valid ${after.valid}  checked ${after.checked}  head id ${after.lastId}`);
  expect(after.valid === true && after.checked === 3,
    'truncation was somehow detected, which would mean this script is wrong');
  console.log('   -> `valid: true` over a shorter history. Nothing IN the table');
  console.log('      records where the table was supposed to end, so the only');
  console.log('      detector is the head, pinned somewhere else:');
  console.log(`      ${before.lastHash.slice(0, 16)}...  !=  ${after.lastHash.slice(0, 16)}...`);
  expect(before.lastHash !== after.lastHash, 'the head did not move');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('4. the fork: fifty concurrent writers, both appends');
// ---------------------------------------------------------------------------
{
  const clients = await Promise.all(
    Array.from({ length: 50 }, async () => {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      return c;
    }),
  );
  try {
    // The two-statement version: read the last hash, then insert.
    await freshChain(1);
    await Promise.all(
      clients.map(async (c, i) => {
        const { rows } = await c.query(
          `SELECT hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
          [ORG],
        );
        const prev = rows[0]?.hash ?? null;
        const action = `concurrent.${i}`;
        await c.query(
          `INSERT INTO audit_event (org_id, action, decision, prev_hash, hash)
           VALUES ($1, $2, 'allow', $3, $4)`,
          [ORG, action, prev, digest(prev, action, 'allow')],
        );
      }),
    );
    let v = await verify(ORG);
    const distinctPrev = (
      await admin.query(
        `SELECT count(DISTINCT prev_hash) AS c FROM audit_event
          WHERE org_id = $1 AND action LIKE 'concurrent.%'`,
        [ORG],
      )
    ).rows[0].c;
    console.log(`   SELECT-then-INSERT   valid ${v.valid}  ${v.problem ?? ''} at id ${v.brokenAt ?? '-'}`);
    console.log(`                        distinct prev_hash among 50 appends: ${distinctPrev}`);
    expect(!v.valid, 'the fork did not reproduce -- 50 writers raced and nothing broke?');
    console.log('   -> an HONEST log that reads as tampered with. Worse than the');
    console.log('      noise: a real tamper is now indistinguishable from this.');

    // The single-statement version.
    await freshChain(1);
    await Promise.all(clients.map((c, i) => append(c, ORG, `concurrent.${i}`)));
    v = await verify(ORG);
    console.log(`   audit_append(...)    valid ${v.valid}  checked ${v.checked}`);
    expect(v.valid && v.checked === 51, 'the single-statement append did not hold the chain');
    console.log('   -> one statement, so the advisory lock is still held when the');
    console.log('      row commits. The second writer waits.\n');
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
}

// ---------------------------------------------------------------------------
console.log('5. trimming the front, with and without an attestation');
// ---------------------------------------------------------------------------
{
  let chain = await freshChain(6);
  await admin.query('DELETE FROM audit_event WHERE id <= $1', [chain[2].id]);
  let v = await verify(ORG);
  console.log(`   trimmed, no checkpoint   valid ${v.valid}  ${v.problem} at id ${v.brokenAt}`);
  expect(!v.valid, 'a bare trim did not read as tampering');
  console.log('   -> which is why retention usually wins and the chain is');
  console.log('      abandoned: honest housekeeping is reported as an attack.');

  chain = await freshChain(6);
  await admin.query(
    `INSERT INTO audit_checkpoint (org_id, kind, through_id, through_hash,
                                   removed_count, removed_from, removed_to, note)
     VALUES ($1, 'trim', $2, $3, 3, $4, $2, 'retention: 90 days')`,
    [ORG, chain[2].id, chain[2].hash, chain[0].id],
  );
  await admin.query('DELETE FROM audit_event WHERE id <= $1', [chain[2].id]);
  v = await verify(ORG);
  console.log(`   same trim, attested      valid ${v.valid}  checked ${v.checked}  attestedGaps ${v.attestedGaps}`);
  expect(v.valid && v.attestedGaps === 3, 'the attested trim did not verify');
  console.log('   -> verifies, and SAYS the history is 3 events shorter than');
  console.log('      what happened. Not the same answer as `valid: true`.\n');
}

await admin.end();
await server.stop();
await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every claim in the guide reproduced.'
    : `${failures} claim(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
