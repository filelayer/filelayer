/**
 * THE LOCAL USAGE REPORT: what it counts, what it refuses to guess, and that
 * building it touches nothing but the database it is given.
 *
 * The properties pinned here are the ones a reader of the report would rely
 * on without being able to check: a count is a count of what happened that
 * week, a field that cannot be read is null with a reason and never 0, the
 * deployment's id does not change between two reports, and the network is not
 * involved. `tools/check-usage-report.mjs` checks the schema is closed and the
 * import graph has no socket in it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

import {
  Filelayer,
  MemoryStorage,
  createTestDb,
  buildUsageReport,
  validateUsageReport,
  isoWeekOf,
  isoWeekRange,
} from '../src/index.ts';

async function deployment() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost:3000' });
  return { db, fl };
}

const thisWeek = () => ({ now: new Date(), week: isoWeekOf(new Date()) });

describe('usage report', () => {
  it('on a fresh database: valid, and every unreadable field is null with its reason', async () => {
    const { db } = await deployment();
    const r = await buildUsageReport(db, thisWeek());
    assert.deepEqual(validateUsageReport(r), []);
    assert.equal(r.format, 1);
    assert.equal(r.schema_version, 16);
    assert.equal(r.errors, null, 'errors are not measured in format 1, so null, not 0');
    assert.equal(r.ops.unshare, null, 'unshare leaves no row of its own, so null, not 0');
    assert.equal(r.storage_kind, null, 'no file exists, so the storage in use is unknown');
    assert.equal(r.first_success_day, null);
    // `lib_version_unknown` appears only where package.json carries no version,
    // which is the documented shape of running this suite from an install.
    assert.deepEqual(
      r.notes.filter((n) => n !== 'lib_version_unknown'),
      ['errors_not_measured', 'unshare_not_recorded', 'no_files', 'no_successful_read'],
    );
    assert.equal(r.lib_version === null, r.notes.includes('lib_version_unknown'), 'null iff noted');
    assert.equal(r.ops.upload, 0, 'the audit log is intact for this week, so zero is a measured zero');
    assert.deepEqual(r.scale_bucket, { files: '0', orgs: '0' });
  });

  it('counts what happened that week, once each', async () => {
    const { db, fl } = await deployment();
    const { id } = await fl.files.put(new TextEncoder().encode('a'), { owner: 'alice' });
    await fl.files.get(id, { as: 'alice' });
    await fl.files.get(id, { as: 'alice' });
    await assert.rejects(() => fl.files.get(id, { as: 'mallory' }));
    const share = await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    await fl.shares.revoke(share.grantId, { as: 'alice' });

    const r = await buildUsageReport(db, thisWeek());
    assert.deepEqual(validateUsageReport(r), []);
    assert.equal(r.ops.upload, 1);
    assert.equal(r.ops.read_allowed, 2, 'two reads, two counted');
    assert.equal(r.ops.read_denied, 1, 'the unknown caller is one refusal');
    assert.equal(r.ops.share_create, 1);
    assert.equal(r.ops.share_revoke, 1);
    assert.equal(r.ops.direct_upload, 0);
    assert.deepEqual(r.storage_kind, ['memory']);
    assert.equal(r.first_success_day, 0);
    assert.equal(r.days_active, 1);
    assert.deepEqual(r.scale_bucket.files, '1-10');
    assert.ok(!r.notes.includes('no_files'));
    assert.ok(!r.notes.includes('no_successful_read'));
  });

  it('keeps one install id across reports, and a deleted row is a new identity', async () => {
    const { db } = await deployment();
    const a = await buildUsageReport(db, thisWeek());
    const b = await buildUsageReport(db, thisWeek());
    assert.equal(a.install_id, b.install_id);
    const { rows } = await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM filelayer_install`);
    assert.equal(Number(rows[0]!.n), 1, 'one row, however many reports');
    await assert.rejects(
      () => db.query(`INSERT INTO filelayer_install (id) VALUES ('00000000-0000-4000-8000-000000000000')`),
      'the table holds one row at most',
    );
    await db.query(`DELETE FROM filelayer_install`);
    const c = await buildUsageReport(db, thisWeek());
    assert.notEqual(c.install_id, a.install_id);
  });

  it('reports audit-derived fields as null when a trim reached into the week', async () => {
    const { db, fl } = await deployment();
    await fl.files.put(new TextEncoder().encode('a'), { owner: 'alice' });
    const { start } = isoWeekRange(isoWeekOf(new Date()));
    await db.query(
      `INSERT INTO audit_checkpoint (kind, through_event_id, through_hash, removed_count, removed_from, removed_to, note)
       VALUES ('trim', 1, 'x', 1, $1, $2, 'test')`,
      [new Date(start.getTime() - 86_400_000).toISOString(), new Date(start.getTime() + 3_600_000).toISOString()],
    );
    const r = await buildUsageReport(db, thisWeek());
    assert.deepEqual(validateUsageReport(r), []);
    assert.ok(r.notes.includes('audit_trimmed'));
    for (const k of ['upload', 'read_allowed', 'read_denied', 'share_create', 'share_revoke', 'direct_upload'] as const) {
      assert.equal(r.ops[k], null, `${k}: an undercount is not reported as a number`);
    }
    assert.equal(r.days_active, null);
    assert.equal(typeof r.ops.job_run, 'number', 'job_run is not read from the audit log');
  });

  it('reports a week that ended before the schema existed as not measured, not as zeros', async () => {
    const { db, fl } = await deployment();
    const { id } = await fl.files.put(new TextEncoder().encode('a'), { owner: 'alice' });
    await fl.files.get(id, { as: 'alice' });
    // createTestDb() created the schema just now, so any earlier week predates it.
    const r = await buildUsageReport(db, { now: new Date(), week: '2026-W02' });
    assert.deepEqual(validateUsageReport(r), []);
    assert.ok(r.notes.includes('before_install'));
    for (const k of ['upload', 'read_allowed', 'read_denied', 'share_create', 'share_revoke', 'direct_upload', 'job_run'] as const) {
      assert.equal(r.ops[k], null, `${k}: the deployment did not exist that week`);
    }
    assert.equal(r.days_active, null);
    assert.equal(r.first_success_day, null);
    // And the current week, same database, is measured as usual.
    const now = await buildUsageReport(db, thisWeek());
    assert.ok(!now.notes.includes('before_install'));
    assert.equal(now.ops.upload, 1);
    assert.equal(now.first_success_day, 0);
  });

  it('defaults to the last complete week, and refuses a week that has not started', async () => {
    const { db } = await deployment();
    const now = new Date('2026-11-04T12:00:00Z');
    const r = await buildUsageReport(db, { now });
    assert.equal(r.week, '2026-W44');
    await assert.rejects(() => buildUsageReport(db, { now, week: '2026-W46' }), /has not started/);
    assert.throws(() => isoWeekRange('2026-W54'), /no such ISO week/);
    assert.throws(() => isoWeekRange('2026-44'), /not an ISO week/);
    assert.equal(isoWeekOf(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  });

  it('builds with every network entry point replaced by one that throws', async () => {
    const { db, fl } = await deployment();
    await fl.files.put(new TextEncoder().encode('a'), { owner: 'alice' });
    const calls: string[] = [];
    const trap = (name: string) => (() => {
      calls.push(name);
      throw new Error(`network: ${name}`);
    }) as never;
    const saved = {
      fetch: globalThis.fetch, http: http.request, https: https.request, net: net.connect, dns: dns.lookup,
    };
    globalThis.fetch = trap('fetch');
    http.request = trap('http.request');
    https.request = trap('https.request');
    net.connect = trap('net.connect');
    dns.lookup = trap('dns.lookup');
    try {
      const r = await buildUsageReport(db, thisWeek());
      assert.deepEqual(validateUsageReport(r), []);
    } finally {
      globalThis.fetch = saved.fetch;
      http.request = saved.http;
      https.request = saved.https;
      net.connect = saved.net;
      dns.lookup = saved.dns;
    }
    assert.deepEqual(calls, []);
  });

  it('the validator refuses what the schema does not publish', async () => {
    const { db } = await deployment();
    const r = await buildUsageReport(db, thisWeek());
    const planted = (f: (x: Record<string, any>) => void) => {
      const x = structuredClone(r) as unknown as Record<string, any>;
      f(x);
      return validateUsageReport(x);
    };
    assert.match(planted((x) => { x.org_id = 'o'; }).join(), /unknown field org_id/);
    assert.match(planted((x) => { x.ops.list = 1; }).join(), /unknown field list/);
    assert.match(planted((x) => { x.storage_kind = ['dropbox']; }).join(), /not one of/);
    assert.match(planted((x) => { x.errors = 0; }).join(), /must be null/);
    assert.match(planted((x) => { x.days_active = 8; }).join(), /above 7/);
    assert.match(planted((x) => { delete x.notes; }).join(), /missing notes/);
    // A null always carries its note, and the always-null fields are null.
    assert.match(planted((x) => { x.ops.unshare = 0; }).join(), /ops\.unshare: is integer, must be null/);
    assert.match(planted((x) => { x.ops.upload = null; }).join(), /ops\.upload: is null, and notes carry none of/);
    assert.match(planted((x) => { x.notes = []; }).join(), /errors: is null, and notes carry none of/);
  });
});
