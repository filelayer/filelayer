#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `revoking-delegated-access.md`, REPRODUCIBLE.
 *
 * The guide beside this file makes six claims about what a database does with
 * delegated grants. Claims about what a constraint refuses are the easiest kind
 * of claim to get wrong while sounding certain, so this is the script that
 * produced them.
 *
 *     node docs/guides/revoking-delegated-access.proof.mjs
 *
 * It needs nothing installed and no server running: `embedded-postgres` starts
 * a real PostgreSQL as an ordinary user process. A real one, and not an
 * in-process engine, because step 5 needs FIFTY BACKENDS at once -- on a
 * single-backend engine the race cannot be staged at all and every version of
 * the budget rule looks correct.
 *
 * What it demonstrates, in order:
 *
 *   1. The flat predicate (`revoked_at IS NULL`) against the chain predicate,
 *      on the same three rows, with the root revoked. Flat says two of three
 *      are live. That is the defect the whole guide is about.
 *   2. Capability amplification is refused.
 *   3. Subject amplification is refused -- the one that capability attenuation
 *      alone lets through.
 *   4. The second statement that walks around an INSERT-only trigger. The
 *      SAME `UPDATE` is run against both trigger definitions: refused by the
 *      one in the guide, accepted by the one without `UPDATE OF`.
 *   5. Budget over the tree. A root capped at 5 delegating three children that
 *      each asked for 5, redeemed 50 times concurrently. Served: 5, not 15.
 *   6. The two bounds: a 33rd delegation is refused, and re-parenting -- the
 *      only way to build a cycle -- is refused.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54391;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const dir = await mkdtemp(join(tmpdir(), 'filelayer-delegation-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL (fifty backends is the whole point)... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const URL = `postgres://postgres:postgres@localhost:${PORT}/proof`;
const admin = new pg.Client({ connectionString: URL });
await admin.connect();

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

/** Run a statement and report the refusal name rather than the stack. */
async function refusal(sql, params = []) {
  try {
    await admin.query(sql, params);
    return null;
  } catch (e) {
    return String(e.message).split(':')[0];
  }
}

// ---------------------------------------------------------------------------
// The schema from the guide, verbatim apart from the two columns that only
// matter to a real tenancy model.
// ---------------------------------------------------------------------------

await admin.query(`
  CREATE TABLE file_grant (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id         uuid NOT NULL,
      parent_grant_id uuid REFERENCES file_grant(id) ON DELETE CASCADE,
      subject_type    text NOT NULL CHECK (subject_type IN ('actor','link','anonymous','org')),
      capabilities    text[] NOT NULL,
      expires_at      timestamptz,
      max_downloads   integer CHECK (max_downloads IS NULL OR max_downloads > 0),
      download_count  integer NOT NULL DEFAULT 0,
      revoked_at      timestamptz,
      UNIQUE (id, file_id),
      FOREIGN KEY (parent_grant_id, file_id) REFERENCES file_grant (id, file_id),
      CONSTRAINT grant_no_self_parent CHECK (parent_grant_id IS NULL OR parent_grant_id <> id),
      CONSTRAINT downloads_within_cap
          CHECK (max_downloads IS NULL OR download_count <= max_downloads)
  )`);

/** Self and every ancestor, root last. */
await admin.query(`
  CREATE FUNCTION grant_lineage(p_grant_id uuid)
  RETURNS TABLE (id uuid, depth int)
  LANGUAGE sql STABLE AS $$
      WITH RECURSIVE chain AS (
          SELECT g.id, g.parent_grant_id, 1 AS depth
            FROM file_grant g WHERE g.id = p_grant_id
          UNION ALL
          SELECT p.id, p.parent_grant_id, c.depth + 1
            FROM chain c JOIN file_grant p ON p.id = c.parent_grant_id
           WHERE c.depth < 64
      )
      SELECT chain.id, chain.depth FROM chain;
  $$`);

/** The predicate from the guide, verbatim. */
await admin.query(`
  CREATE FUNCTION grant_is_live(p_grant_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE COST 100 AS $$
      WITH RECURSIVE chain AS (
          SELECT g.id, g.parent_grant_id, 1 AS depth,
                 (    g.revoked_at IS NULL
                  AND (g.expires_at IS NULL OR g.expires_at > now())
                  AND (g.max_downloads IS NULL OR g.download_count < g.max_downloads)
                 ) AS self_live
            FROM file_grant g
           WHERE g.id = p_grant_id
          UNION ALL
          SELECT p.id, p.parent_grant_id, c.depth + 1,
                 (    p.revoked_at IS NULL
                  AND (p.expires_at IS NULL OR p.expires_at > now())
                  AND (p.max_downloads IS NULL OR p.download_count < p.max_downloads)
                 )
            FROM chain c
            JOIN file_grant p ON p.id = c.parent_grant_id
           WHERE c.depth < 64
             AND c.self_live
      )
      SELECT coalesce(bool_and(chain.self_live), false)
             AND NOT EXISTS (
                 SELECT 1 FROM chain d
                  WHERE d.depth >= 64 AND d.parent_grant_id IS NOT NULL
             )
        FROM chain;
  $$`);

/** The attenuation function from the guide, with all four dimensions. */
await admin.query(`
  CREATE FUNCTION file_grant_attenuate() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
      p        file_grant%ROWTYPE;
      v_remain integer;
      v_depth  integer;
  BEGIN
      IF TG_OP = 'UPDATE' AND NEW.parent_grant_id IS DISTINCT FROM OLD.parent_grant_id THEN
          RAISE EXCEPTION 'grant_lineage_immutable: parent_grant_id cannot be changed';
      END IF;

      IF NEW.parent_grant_id IS NULL THEN
          RETURN NEW;
      END IF;

      IF NEW.subject_type NOT IN ('actor', 'link') THEN
          RAISE EXCEPTION
              'grant_subject_amplification: a delegated grant may only name an actor or a link, not %',
              NEW.subject_type;
      END IF;

      SELECT * INTO p FROM file_grant WHERE id = NEW.parent_grant_id;
      IF NOT FOUND THEN
          RAISE EXCEPTION 'grant_parent_missing: parent grant % does not exist', NEW.parent_grant_id;
      END IF;

      SELECT count(*) INTO v_depth FROM grant_lineage(NEW.parent_grant_id);
      IF v_depth >= 32 THEN
          RAISE EXCEPTION 'grant_delegation_too_deep: delegation chain would exceed 32';
      END IF;

      IF NOT grant_is_live(p.id) THEN
          RAISE EXCEPTION 'grant_parent_not_live: cannot delegate from a dead grant';
      END IF;

      IF NOT (NEW.capabilities <@ p.capabilities) THEN
          RAISE EXCEPTION 'grant_capability_amplification: % exceeds parent %',
              NEW.capabilities, p.capabilities;
      END IF;

      IF p.expires_at IS NOT NULL
         AND (NEW.expires_at IS NULL OR NEW.expires_at > p.expires_at) THEN
          NEW.expires_at := p.expires_at;
      END IF;

      IF p.max_downloads IS NOT NULL THEN
          v_remain := p.max_downloads - p.download_count;
          IF v_remain <= 0 THEN
              RAISE EXCEPTION 'grant_parent_exhausted: parent has no downloads left to delegate';
          END IF;
          IF NEW.max_downloads IS NULL OR NEW.max_downloads > v_remain THEN
              NEW.max_downloads := v_remain;
          END IF;
      END IF;

      RETURN NEW;
  END;
  $$`);

// The guide's `UPDATE OF` list also names `subject_id`, `subject_org_id` and
// `subject_min_role`. This table has no such columns -- it models one subject
// dimension, not a whole tenancy -- so the list here is the subset that exists.
// `subject_type` is the one step 4 turns on.
const TRIGGER_FROM_THE_GUIDE = `
  CREATE TRIGGER file_grant_attenuation
      BEFORE INSERT OR UPDATE OF parent_grant_id, capabilities, expires_at,
                                 max_downloads, subject_type
      ON file_grant
      FOR EACH ROW EXECUTE FUNCTION file_grant_attenuate()`;

const TRIGGER_INSERT_ONLY = `
  CREATE TRIGGER file_grant_attenuation
      BEFORE INSERT
      ON file_grant
      FOR EACH ROW EXECUTE FUNCTION file_grant_attenuate()`;

await admin.query(TRIGGER_FROM_THE_GUIDE);

/** A download consumes the budget of the ENTIRE ancestor chain. */
await admin.query(`
  CREATE FUNCTION consume_download(p_grant_id uuid) RETURNS boolean
  LANGUAGE plpgsql AS $$
  DECLARE v_ids uuid[];
  BEGIN
      -- Deterministic lock order over the whole chain. Two redemptions on
      -- sibling branches share ancestors; without one order they deadlock.
      SELECT array_agg(l.id ORDER BY l.id) INTO v_ids FROM grant_lineage(p_grant_id) l;
      IF v_ids IS NULL THEN RETURN false; END IF;
      PERFORM 1 FROM file_grant WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;

      -- Re-asked AFTER the lock, which is what makes it a reservation rather
      -- than a check with a window after it.
      IF NOT grant_is_live(p_grant_id) THEN RETURN false; END IF;

      UPDATE file_grant SET download_count = download_count + 1 WHERE id = ANY(v_ids);
      RETURN true;
  END;
  $$`);

const FILE = '11111111-1111-1111-1111-111111111111';

/** Insert a grant and return its id, or throw with the refusal name. */
async function mint({ parent = null, subject = 'actor', caps = ['read'], cap = null }) {
  const { rows } = await admin.query(
    `INSERT INTO file_grant (file_id, parent_grant_id, subject_type, capabilities, max_downloads)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, max_downloads`,
    [FILE, parent, subject, caps, cap],
  );
  return rows[0];
}

const live = async (id) => (await admin.query('SELECT grant_is_live($1) AS v', [id])).rows[0].v;
const flat = async (id) =>
  (await admin.query('SELECT revoked_at IS NULL AS v FROM file_grant WHERE id = $1', [id])).rows[0]
    .v;

// ---------------------------------------------------------------------------
console.log('1. the flat predicate against the chain predicate, root revoked');
// ---------------------------------------------------------------------------
{
  const a = await mint({});
  const b = await mint({ parent: a.id });
  const c = await mint({ parent: b.id });
  await admin.query('UPDATE file_grant SET revoked_at = now() WHERE id = $1', [a.id]);

  const flats = [await flat(a.id), await flat(b.id), await flat(c.id)];
  const chains = [await live(a.id), await live(b.id), await live(c.id)];
  console.log(`   revoked_at IS NULL       live ${flats.filter(Boolean).length} of 3   [${flats}]`);
  console.log(`   grant_is_live(id)        live ${chains.filter(Boolean).length} of 3   [${chains}]`);
  expect(flats.filter(Boolean).length === 2, 'the flat predicate did not keep the children alive');
  expect(chains.filter(Boolean).length === 0, 'the chain predicate left something live');
  console.log('   -> the same three rows. One predicate leaves two people reading.\n');
}

// ---------------------------------------------------------------------------
console.log('2. capability amplification');
// ---------------------------------------------------------------------------
{
  const parent = await mint({ caps: ['read'] });
  const r = await refusal(
    `INSERT INTO file_grant (file_id, parent_grant_id, subject_type, capabilities)
     VALUES ($1, $2, 'actor', ARRAY['read','delete'])`,
    [FILE, parent.id],
  );
  console.log(`   child {read,delete} from parent {read}   ${r ?? 'ACCEPTED'}`);
  expect(r === 'grant_capability_amplification', 'the capability check did not refuse');
  console.log('   -> refused.\n');
}

// ---------------------------------------------------------------------------
console.log('3. subject amplification -- the one a capability subset allows');
// ---------------------------------------------------------------------------
{
  const parent = await mint({ subject: 'actor', caps: ['read'] });
  for (const wider of ['anonymous', 'org']) {
    const r = await refusal(
      `INSERT INTO file_grant (file_id, parent_grant_id, subject_type, capabilities)
       VALUES ($1, $2, $3, ARRAY['read'])`,
      [FILE, parent.id, wider],
    );
    console.log(`   child subject '${wider}' with capabilities {read} <@ {read}   ${r ?? 'ACCEPTED'}`);
    expect(r === 'grant_subject_amplification', `'${wider}' was not refused`);
  }
  console.log('   -> both refused. Attenuation was satisfied; breadth was not.\n');
}

// ---------------------------------------------------------------------------
console.log('4. the second statement, against both trigger definitions');
// ---------------------------------------------------------------------------
{
  const widen = async (child) =>
    refusal(`UPDATE file_grant SET subject_type = 'org' WHERE id = $1`, [child]);

  const parent = await mint({});
  const child = await mint({ parent: parent.id });
  let r = await widen(child.id);
  console.log(`   BEFORE INSERT OR UPDATE OF ... subject_type   ${r ?? 'ACCEPTED'}`);
  expect(r === 'grant_subject_amplification', 'the UPDATE was not refused');

  await admin.query('DROP TRIGGER file_grant_attenuation ON file_grant');
  await admin.query(TRIGGER_INSERT_ONLY);
  const parent2 = await mint({});
  const child2 = await mint({ parent: parent2.id });
  r = await widen(child2.id);
  const now = (
    await admin.query('SELECT subject_type FROM file_grant WHERE id = $1', [child2.id])
  ).rows[0].subject_type;
  console.log(`   BEFORE INSERT only                            ${r ?? 'ACCEPTED'}  (now '${now}')`);
  expect(r === null && now === 'org', 'the INSERT-only trigger did not let the widening through');

  await admin.query('DROP TRIGGER file_grant_attenuation ON file_grant');
  await admin.query(TRIGGER_FROM_THE_GUIDE);
  console.log('   -> one delegated grant became an org-wide one, in one statement.\n');
}

// ---------------------------------------------------------------------------
console.log('5. budget over the tree: a root of 5 delegating three children of 5');
// ---------------------------------------------------------------------------
{
  const root = await mint({ cap: 5 });
  const kids = [];
  for (let i = 0; i < 3; i++) kids.push(await mint({ parent: root.id, cap: 5 }));
  console.log(`   each child ASKED for 5, each was stored as   ${kids.map((k) => k.max_downloads)}`);
  expect(
    kids.every((k) => Number(k.max_downloads) === 5),
    'the children were not clamped to the parent remainder of 5',
  );
  console.log('   -> legal at creation, and three times the budget if that is where it stops.');

  const clients = await Promise.all(
    Array.from({ length: 50 }, async () => {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      return c;
    }),
  );
  let served;
  try {
    const got = await Promise.all(
      clients.map((c, i) =>
        c
          .query('SELECT consume_download($1) AS ok', [kids[i % 3].id])
          .then((r) => r.rows[0].ok)
          .catch((e) => `ERR:${e.code}`),
      ),
    );
    served = got.filter((x) => x === true).length;
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
  const counts = (
    await admin.query('SELECT download_count FROM file_grant WHERE id = $1', [root.id])
  ).rows[0].download_count;
  console.log(`   50 concurrent redemptions across the three   served ${served}  root counter ${counts}`);
  expect(served === 5 && Number(counts) === 5, `expected exactly 5 served, got ${served}`);

  const stillLive = await Promise.all(kids.map((k) => live(k.id)));
  console.log(`   the three children afterwards                live [${stillLive}]`);
  expect(stillLive.every((v) => v === false), 'exhaustion did not propagate down');
  console.log('   -> exactly the root cap, and exhaustion propagated for free.\n');
}

// ---------------------------------------------------------------------------
console.log('6. the two bounds');
// ---------------------------------------------------------------------------
{
  let node = await mint({});
  let depth = 1;
  let stopped = null;
  while (depth <= 40) {
    let next = null;
    try {
      const { rows } = await admin.query(
        `INSERT INTO file_grant (file_id, parent_grant_id, subject_type, capabilities)
         VALUES ($1, $2, 'actor', ARRAY['read']) RETURNING id`,
        [FILE, node.id],
      );
      next = rows[0];
    } catch (e) {
      stopped = String(e.message).split(':')[0];
      break;
    }
    node = next;
    depth++;
  }
  console.log(`   chain built to depth                         ${depth}`);
  console.log(`   the 33rd delegation                          ${stopped ?? 'ACCEPTED'}`);
  expect(depth === 32, `expected the 33rd delegation to be refused, reached ${depth}`);
  expect(stopped === 'grant_delegation_too_deep', 'the depth bound did not refuse');
  expect(await live(node.id), 'a chain at exactly the creation bound was not live');
  console.log('   the deepest grant is live                    true');
  console.log('   -> created up to 32; the liveness bound of 64 sits above it, so a');
  console.log('      legal chain is never the thing that trips the safety bound.');

  const root = await mint({});
  const other = await mint({});
  const r = await refusal('UPDATE file_grant SET parent_grant_id = $1 WHERE id = $2', [
    other.id,
    root.id,
  ]);
  console.log(`   re-parenting an existing grant               ${r ?? 'ACCEPTED'}`);
  expect(r === 'grant_lineage_immutable', 're-parenting was not refused');
  console.log('   -> refused, which is why a cycle cannot be built.\n');
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
