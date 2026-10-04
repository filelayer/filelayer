#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `multi-tenant-file-access.md`, REPRODUCIBLE.
 *
 * The guide beside this file claims that Row-Level Security filters reads and
 * does not stop you WRITING a row that joins two tenants, and that a composite
 * foreign key does — against every writer, including one that has bypassed RLS
 * entirely. Those are claims about PostgreSQL, so they are demonstrated against
 * PostgreSQL rather than asserted.
 *
 *     node docs/guides/multi-tenant-file-access.proof.mjs
 *
 * `embedded-postgres` starts a real server as an ordinary user process. Nothing
 * to install, no Docker, no daemon left behind.
 *
 * What it demonstrates, in order:
 *
 *   1. RLS on, policy correct, session variable set: a tenant reads only its own
 *      files. The part everybody gets right.
 *   2. The same session INSERTS a grant joining tenant A's file to tenant B's
 *      org. RLS has nothing to say about it, and it succeeds.
 *   3. Add the composite foreign key. The identical INSERT is refused.
 *   4. The refusal holds for a role with BYPASSRLS. A policy is advice to a
 *      session; a constraint is a property of the data.
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

const dir = await mkdtemp(join(tmpdir(), 'filelayer-tenant-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const base = `postgres://postgres:postgres@localhost:${PORT}/proof`;
const admin = new pg.Client({ connectionString: base });
await admin.connect();

// --- the schema a good multi-tenant tutorial produces -----------------------
await admin.query(`
  CREATE TABLE org (
      id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL
  );

  CREATE TABLE file (
      id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES org(id),
      name   text NOT NULL
      -- step 3 adds: UNIQUE (id, org_id)
  );

  CREATE TABLE file_grant (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid NOT NULL REFERENCES file(id),
      org_id  uuid NOT NULL REFERENCES org(id),
      note    text
      -- step 3 adds: FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id)
  );

  ALTER TABLE file       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE file       FORCE  ROW LEVEL SECURITY;
  ALTER TABLE file_grant ENABLE ROW LEVEL SECURITY;
  ALTER TABLE file_grant FORCE  ROW LEVEL SECURITY;

  CREATE POLICY file_tenant ON file
      USING (org_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.tenant_id', true)::uuid);

  CREATE POLICY grant_tenant ON file_grant
      USING (org_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.tenant_id', true)::uuid);

  CREATE ROLE app LOGIN PASSWORD 'app';
  GRANT SELECT, INSERT, UPDATE, DELETE ON org, file, file_grant TO app;

  CREATE ROLE bypasser LOGIN PASSWORD 'bypass' BYPASSRLS;
  GRANT SELECT, INSERT, UPDATE, DELETE ON org, file, file_grant TO bypasser;
`);

const { rows: orgs } = await admin.query(
  `INSERT INTO org (name) VALUES ('acme'), ('globex') RETURNING id, name`,
);
const acme = orgs.find((o) => o.name === 'acme').id;
const globex = orgs.find((o) => o.name === 'globex').id;

const { rows: files } = await admin.query(
  `INSERT INTO file (org_id, name) VALUES ($1, 'acme-contract.pdf'), ($2, 'globex-deck.pdf')
   RETURNING id, org_id, name`,
  [acme, globex],
);
const acmeFile = files.find((f) => f.name === 'acme-contract.pdf').id;

async function asTenant(role, tenantId, fn) {
  const c = new pg.Client({ connectionString: base.replace('postgres:postgres', `${role}:${role === 'app' ? 'app' : 'bypass'}`) });
  await c.connect();
  try {
    if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.end();
  }
}

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

// --- 1. the part everybody gets right ---------------------------------------
console.log('1. RLS filters reads, and it works');
const visible = await asTenant('app', acme, async (c) => {
  const { rows } = await c.query('SELECT name FROM file ORDER BY name');
  return rows.map((r) => r.name);
});
console.log(`   acme sees: ${JSON.stringify(visible)}`);
expect(visible.length === 1 && visible[0] === 'acme-contract.pdf', 'RLS did not isolate reads');
console.log('   -> globex-deck.pdf is invisible. This is the part the tutorials cover.\n');

// --- 2. and it says nothing about a row that joins two tenants --------------
console.log('2. the same session writes a grant joining acme\'s FILE to globex\'s ORG');
const wrote = await asTenant('app', globex, async (c) => {
  try {
    await c.query('INSERT INTO file_grant (file_id, org_id, note) VALUES ($1, $2, $3)', [
      acmeFile,
      globex,
      'globex may read an acme file',
    ]);
    return 'INSERTED';
  } catch (e) {
    return `REFUSED:${e.code}`;
  }
});
console.log(`   result: ${wrote}`);
expect(wrote === 'INSERTED', 'expected RLS to allow the cross-tenant grant');
console.log(
  '   -> accepted. Both policies are satisfied: the row\'s org_id IS globex.\n' +
    '      RLS checked the row against the session. It never checked the row\n' +
    '      against the FILE the row points at.\n',
);

// --- 3. the composite foreign key -------------------------------------------
console.log('3. the same INSERT, with the composite foreign key in place');
await admin.query('DELETE FROM file_grant');
await admin.query('ALTER TABLE file ADD UNIQUE (id, org_id)');
await admin.query(
  'ALTER TABLE file_grant ADD FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id)',
);
const refused = await asTenant('app', globex, async (c) => {
  try {
    await c.query('INSERT INTO file_grant (file_id, org_id, note) VALUES ($1, $2, $3)', [
      acmeFile,
      globex,
      'globex may read an acme file',
    ]);
    return 'INSERTED';
  } catch (e) {
    return `REFUSED:${e.code}`;
  }
});
console.log(`   result: ${refused}`);
expect(refused === 'REFUSED:23503', 'expected a foreign-key violation');
console.log(
  '   -> refused, 23503. The pair (file_id, org_id) is not a row in `file`,\n' +
    '      so the grant cannot exist. Not a policy about who is asking:\n' +
    '      a statement about which rows are possible.\n',
);

// --- 4. and it holds for a writer that bypasses RLS entirely ----------------
console.log('4. the same INSERT as a role with BYPASSRLS, no tenant variable set');
const bypassed = await asTenant('bypasser', null, async (c) => {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM file');
  const sees = rows[0].n;
  try {
    await c.query('INSERT INTO file_grant (file_id, org_id, note) VALUES ($1, $2, $3)', [
      acmeFile,
      globex,
      'from a session with no policy over it',
    ]);
    return { sees, result: 'INSERTED' };
  } catch (e) {
    return { sees, result: `REFUSED:${e.code}` };
  }
});
console.log(`   this role sees all ${bypassed.sees} files, and the write: ${bypassed.result}`);
expect(bypassed.sees === 2, 'BYPASSRLS did not actually bypass');
expect(bypassed.result === 'REFUSED:23503', 'the constraint did not hold against BYPASSRLS');
console.log(
  '   -> reads every row, and still cannot write that grant. A policy is advice\n' +
    '      to a session. A constraint is a property of the data.\n',
);

await admin.end();
await server.stop();
await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every claim in the guide reproduced.'
    : `${failures} claim(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
