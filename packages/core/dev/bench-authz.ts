/**
 * Cost of an authorization check, before and after recursive grant liveness.
 *
 * Runs unchanged against the pre-fix tree (membership is inserted with SQL), so
 * the two columns are comparable. PGlite is PostgreSQL compiled to WASM and is
 * several times slower than a native backend in absolute terms; what is
 * meaningful here is the RATIO between the paths, not the milliseconds.
 *
 * Run: npm run dev:bench (from the repository root)
 */

import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { authorize } from '../src/authz.ts';

const enc = (s: string) => new TextEncoder().encode(s);
let seq = 0;

const { db } = await createTestDb();
const fl = new Filelayer(db, new MemoryStorage());

const org = (
  await db.query<{ id: string }>(
    `INSERT INTO org (external_id) VALUES ('bench') RETURNING id`,
  )
).rows[0]!.id;

async function actor(role: string | null): Promise<string> {
  const id = (
    await db.query<{ id: string }>(`INSERT INTO actor (external_id) VALUES ($1) RETURNING id`, [
      `b-${seq++}`,
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
}

const owner = await actor('owner');
const file = await fl.upload({ actorId: owner }, org, {
  name: 'bench.pdf',
  contentType: 'application/pdf',
  body: enc('BENCH'),
});

// A delegation chain, so liveness can be measured at depth.
const holders: string[] = [];
const chainDepth = 8;
{
  let issuer = { actorId: owner };
  for (let d = 0; d < chainDepth; d++) {
    const h = await actor(null);
    await fl.share(issuer, file.id, {
      subject: { type: 'actor', actorId: h },
      capabilities: ['read', 'share'],
    });
    holders.push(h);
    issuer = { actorId: h };
  }
}

// Background load: unrelated delegation trees on other files, so that a
// formulation which walks the whole table rather than one chain shows up.
{
  const noise = await actor('member');
  for (let f = 0; f < 20; f++) {
    const nf = await fl.upload({ actorId: owner }, org, {
      name: `noise-${f}.pdf`,
      contentType: 'application/pdf',
      body: enc('N'),
    });
    let issuer = { actorId: owner };
    for (let d = 0; d < 4; d++) {
      await fl.share(issuer, nf.id, {
        subject: { type: 'actor', actorId: noise },
        capabilities: ['read', 'share'],
      });
      issuer = { actorId: noise };
    }
  }
}

async function bench(label: string, n: number, fn: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 20; i++) await fn(); // warm
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(n * 0.5)]!;
  const p95 = samples[Math.floor(n * 0.95)]!;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  console.log(
    `${label.padEnd(46)} mean ${mean.toFixed(3)}ms  p50 ${p50.toFixed(3)}ms  p95 ${p95.toFixed(3)}ms`,
  );
}

const N = 300;
console.log(`authorization cost, ${N} samples each (PGlite/WASM; ratios matter, not absolutes)\n`);

await bench('authorize read, via org role (no grants)', N, () =>
  authorize(fl.store, { actorId: owner }, file.id, 'read'),
);
for (const depth of [1, 2, 4, 8]) {
  await bench(`authorize read, via grant at depth ${depth}`, N, () =>
    authorize(fl.store, { actorId: holders[depth - 1]! }, file.id, 'read'),
  );
}
await bench('  ...of which: the grant lookup alone (d=8)', N, () =>
  fl.store.getActorGrants(file.id, holders[7]!),
);
await bench('  ...same lookup with liveness removed (d=8)', N, () =>
  db.query(
    `SELECT * FROM file_grant WHERE file_id = $1 AND subject_type = 'actor' AND subject_id = $2`,
    [file.id, holders[7]!],
  ),
);

// The formulation we did NOT ship, for the record.
const hasRecursiveView =
  (await db.query(`SELECT 1 FROM pg_views WHERE viewname = 'live_grant_recursive'`)).rows.length > 0;
if (hasRecursiveView) {
  await bench('  ...top-down recursive VIEW instead (d=8)', N, () =>
    db.query(
      `SELECT * FROM live_grant_recursive WHERE file_id = $1 AND subject_type = 'actor' AND subject_id = $2`,
      [file.id, holders[7]!],
    ),
  );
}

const link = await fl.share({ actorId: owner }, file.id, { subject: { type: 'link' } });
await bench('redeem() end to end', 100, () => fl.redeem(link.secret!));

// -----------------------------------------------------------------------------
// RFC-001: THE COST OF A GROUP SUBJECT.
//
// The claim under test is "one join on the grant path". Two things have to be
// true for that to be honest:
//
//   1. the group lookup itself is one indexed probe plus a membership join, not
//      a scan;
//   2. a principal who is authorized WITHOUT a group grant does not pay for the
//      feature beyond that one extra query -- which is the case that dominates
//      every existing workload.
//
// The second is the one that would make this a regression, so it is measured
// against the role path and the actor-grant path above, on the same file, in
// the same process.
// -----------------------------------------------------------------------------
{
  const partner = (
    await db.query<{ id: string }>(
      `INSERT INTO org (external_id) VALUES ('bench-partner') RETURNING id`,
    )
  ).rows[0]!.id;

  // A partner org of realistic size. The whole point of the design is that this
  // number does not appear in the cost of a decision -- there is no fan-out, so
  // the grant table does not grow with it.
  const partnerMembers: string[] = [];
  for (let i = 0; i < 200; i++) {
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO actor (external_id) VALUES ($1) RETURNING id`,
        [`bench-partner-${i}`],
      )
    ).rows[0]!.id;
    await db.query(`INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)`, [
      partner,
      id,
      i === 0 ? 'owner' : i % 3 === 0 ? 'admin' : 'member',
    ]);
    partnerMembers.push(id);
  }

  const groupFile = await fl.upload({ actorId: owner }, org, {
    name: 'group.pdf',
    contentType: 'application/pdf',
    body: enc('GROUP'),
  });
  await fl.share({ actorId: owner }, groupFile.id, {
    subject: { type: 'org', orgId: partner },
  });
  const roleFile = await fl.upload({ actorId: owner }, org, {
    name: 'role.pdf',
    contentType: 'application/pdf',
    body: enc('ROLE'),
  });
  await fl.share({ actorId: owner }, roleFile.id, {
    subject: { type: 'role', orgId: partner, minRole: 'admin' },
  });

  const { rows: gc } = await db.query<{ c: number }>(
    `SELECT count(*)::int c FROM file_grant WHERE file_id IN ($1,$2)`,
    [groupFile.id, roleFile.id],
  );
  console.log(`\ngroup subjects: 200-member partner org, ${gc[0]!.c} grant rows total\n`);

  const memberOfPartner = partnerMembers[3]!; // an 'admin', so both grants match
  await bench('authorize read, via ORG grant (200 members)', N, () =>
    authorize(fl.store, { actorId: memberOfPartner }, groupFile.id, 'read'),
  );
  await bench('authorize read, via ROLE grant, floor=admin', N, () =>
    authorize(fl.store, { actorId: memberOfPartner }, roleFile.id, 'read'),
  );
  await bench('  ...of which: the group lookup alone', N, () =>
    fl.store.getGroupGrants(groupFile.id, memberOfPartner),
  );
  // The DENIED case is the one an attacker drives, and it must not be slower.
  const outsider = await actor(null);
  await bench('authorize read, group grant, NON-member (deny)', N, () =>
    authorize(fl.store, { actorId: outsider }, groupFile.id, 'read'),
  );
  // The cost the feature imposes on everyone else: one extra query on a path
  // that finds no group grant at all.
  await bench('authorize read, via org role (group miss)', N, () =>
    authorize(fl.store, { actorId: owner }, groupFile.id, 'read'),
  );

  await bench('listFiles(50), member of the partner org', 100, () =>
    fl.listFiles({ actorId: memberOfPartner }, org, { limit: 50 }),
  );
  await bench('listFiles(50), org owner (no group grant matches)', 100, () =>
    fl.listFiles({ actorId: owner }, org, { limit: 50 }),
  );
}

// -----------------------------------------------------------------------------
// Does the liveness predicate scale with the size of the DELEGATION CHAIN, or
// with the size of the TABLE? Only the first is acceptable.
// -----------------------------------------------------------------------------
if (hasRecursiveView) {
  console.log('\nscaling: one lookup, against a growing grant table\n');
  const noise2 = await actor('member');
  for (const target of [500, 2000]) {
    let total = Number(
      (await db.query<{ c: number }>(`SELECT count(*)::int c FROM file_grant`)).rows[0]!.c,
    );
    while (total < target) {
      const nf = await fl.upload({ actorId: owner }, org, {
        name: `bulk-${total}.pdf`,
        contentType: 'application/pdf',
        body: enc('N'),
      });
      let issuer = { actorId: owner };
      for (let d = 0; d < 4 && total < target; d++) {
        await fl.share(issuer, nf.id, {
          subject: { type: 'actor', actorId: noise2 },
          capabilities: ['read', 'share'],
        });
        issuer = { actorId: noise2 };
        total++;
      }
    }
    await bench(`  grant_is_live (shipped),      ${total} grants`, 100, () =>
      fl.store.getActorGrants(file.id, holders[7]!),
    );
    await bench(`  top-down recursive VIEW,      ${total} grants`, 100, () =>
      db.query(
        `SELECT * FROM live_grant_recursive WHERE file_id = $1 AND subject_type = 'actor' AND subject_id = $2`,
        [file.id, holders[7]!],
      ),
    );
  }
}
