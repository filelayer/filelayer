// test/setup.js  --  test harness (excluded from application LOC)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SupabaseProject } from '../src/platform/supabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');
const sql = (f) => readFileSync(join(sqlDir, f), 'utf8');

export let clockOffsetMs = 0;
export const advanceClock = (ms) => { clockOffsetMs += ms; };
export const resetClock = () => { clockOffsetMs = 0; };

// Each test boots its own Postgres. They must be closed or the WASM instances
// accumulate and the runner dies partway through the file.
export const openDbs = [];
export async function closeAll() {
  while (openDbs.length) { try { await openDbs.pop().close(); } catch { /* noop */ } }
}

export async function boot({ configB = false } = {}) {
  const db = await new PGlite();
  openDbs.push(db);
  for (const f of ['00_platform_emulation.sql', '10_app_schema.sql',
                   '20_rls_policies.sql', '30_audit.sql', '90_rbac_jwt_variant.sql']) {
    await db.exec(sql(f));
  }
  if (configB) await db.exec(sql('25_config_b_lockdown.sql'));

  await db.exec(`insert into storage.buckets (id, name, public) values ('vault','vault',false);`);

  const sb = new SupabaseProject(db, {
    jwtSecret: 'auth-jwt-secret-not-the-storage-one',
    storageSigningKey: 'storage-signing-key-separate-per-project',
    clock: () => Date.now() + clockOffsetMs,
  });

  const q = (text, params = []) => db.query(text, params);
  const mkUser = async (email) =>
    (await q('insert into public.app_users (email) values ($1) returning id', [email])).rows[0].id;
  const mkOrg = async (name) =>
    (await q('insert into public.orgs (name) values ($1) returning id', [name])).rows[0].id;
  const member = (org, user, role) =>
    q('insert into public.org_members (org_id, user_id, role) values ($1,$2,$3)',
      [org, user, role]);

  const orgA = await mkOrg('Acme');
  const orgB = await mkOrg('Beta');
  const u = {
    alice: await mkUser('alice@acme.test'),   // A owner
    adam:  await mkUser('adam@acme.test'),    // A admin
    mia:   await mkUser('mia@acme.test'),     // A member
    mo:    await mkUser('mo@acme.test'),      // A member
    vera:  await mkUser('vera@acme.test'),    // A viewer
    bob:   await mkUser('bob@beta.test'),     // B owner
    eve:   await mkUser('eve@beta.test'),     // B member (attacker)
  };
  await member(orgA, u.alice, 'owner');
  await member(orgA, u.adam, 'admin');
  await member(orgA, u.mia, 'member');
  await member(orgA, u.mo, 'member');
  await member(orgA, u.vera, 'viewer');
  await member(orgB, u.bob, 'owner');
  await member(orgB, u.eve, 'member');

  const tok = {};
  for (const [k, id] of Object.entries(u)) tok[k] = sb.issueAccessToken(id);

  return { db, sb, orgA, orgB, u, tok };
}

/** Assert a call is refused. Returns the error for inspection. */
export async function refused(fn) {
  try {
    const r = await fn();
    throw new Error(`EXPECTED REFUSAL, but call succeeded with: ${JSON.stringify(r)?.slice(0, 200)}`);
  } catch (e) {
    if (/EXPECTED REFUSAL/.test(e.message)) throw e;
    return e;
  }
}
