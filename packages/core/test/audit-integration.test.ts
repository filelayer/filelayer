/**
 * THE HARNESS HAS TO CATCH A BROKEN APPLICATION, NOT JUST PASS A GOOD ONE.
 *
 * `auditIntegration()` tells an adopter whether THEIR routes hold the
 * properties. A harness that only ever runs against a correct application is
 * unverified in the way that matters: every one of its checks could be
 * returning `pass` unconditionally and nobody would know.
 *
 * So each check here is exercised twice. Once against a correct application,
 * built out of this library's own `deliveryFetch`, where it must pass. Once
 * against the same application with exactly one property broken, where that
 * check and only that check must fail.
 *
 * The broken variants are not strawmen. Each is a mistake that is easy to make
 * and looks fine in a browser: answering 403 instead of 404, stripping a
 * security header at a proxy, letting a failed session lookup fall through to
 * anonymous, a 416 for a range that should have been ignored.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { deliveryFetch } from '../src/delivery.ts';
import {
  auditIntegration,
  formatAuditReport,
  type AuditResponse,
  type IntegrationUnderTest,
} from '../src/audit-integration.ts';

const OWNER = 'alice';
const STRANGER = 'bob';

/** A correct application: this library's own route, mounted the documented way. */
async function app(): Promise<{ under: IntegrationUnderTest; fl: Filelayer }> {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://app.test' });
  await fl.orgs.create('acme', { owner: OWNER });
  await fl.ids.ensureActor(STRANGER);

  const serve = deliveryFetch(fl, {
    principal: async (req) => ({ as: req.headers.get('x-user') }),
  });

  const toAudit = async (res: Response): Promise<AuditResponse> => ({
    status: res.status,
    // `res.headers.forEach` rather than spreading: the DOM lib this package
    // compiles against types `Headers` without an iterator, and a test that
    // only runs under a looser tsconfig is a test that stops running.
    headers: (() => {
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return out;
    })(),
    body: new Uint8Array(await res.arrayBuffer()),
  });

  const under: IntegrationUnderTest = {
    async upload({ owner, name, body }) {
      const { id } = await fl.files.put(body, { org: 'acme', owner, name });
      return { id, url: `http://app.test/f/${id}` };
    },
    async get(url, who, extraHeaders) {
      const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
      if (who !== null) headers['x-user'] = who;
      const res = await serve(new Request(url, { headers }));
      return res
        ? toAudit(res)
        : { status: 404, headers: {}, body: new Uint8Array() };
    },
    async share(id, user) {
      await fl.shares.create(id, { as: OWNER, withUser: user });
    },
    async unshare(id, user) {
      await fl.shares.unshare(id, { as: OWNER, user });
    },
  };
  return { under, fl };
}

/** The same application with one response property rewritten on the way out. */
function broken(
  under: IntegrationUnderTest,
  mangle: (r: AuditResponse, ctx: { who: string | null; range?: string }) => AuditResponse,
): IntegrationUnderTest {
  return {
    ...under,
    async get(url, who, extraHeaders) {
      const r = await under.get(url, who, extraHeaders);
      return mangle(r, { who, ...(extraHeaders?.range ? { range: extraHeaders.range } : {}) });
    },
  };
}

const run = (under: IntegrationUnderTest) =>
  auditIntegration({ owner: OWNER, stranger: STRANGER, app: under });

const outcomeOf = (report: Awaited<ReturnType<typeof run>>, fragment: string) => {
  const found = report.checks.filter((c) => c.name.includes(fragment));
  assert.equal(found.length, 1, `expected exactly one check matching "${fragment}", got ${found.length}`);
  return found[0]!;
};

// -----------------------------------------------------------------------------

describe('auditIntegration against a correct application', () => {
  it('passes every check, and skips nothing it was given the means to run', async () => {
    const { under } = await app();
    const report = await run(under);
    assert.equal(report.failed, 0, formatAuditReport(report));
    assert.equal(report.skipped, 0, 'with share/unshare supplied, nothing should skip');
    assert.ok(report.ok);
    assert.ok(report.passed >= 10, `only ${report.passed} checks ran`);
  });

  it('skips the revocation check rather than failing it when it cannot run it', async () => {
    const { under } = await app();
    const { share: _s, unshare: _u, ...noSharing } = under;
    const report = await run(noSharing as IntegrationUnderTest);
    assert.equal(outcomeOf(report, 'revocation').outcome, 'skipped');
    assert.equal(report.ok, true, 'a skip must not fail the run');
  });
});

describe('auditIntegration against an application with one thing wrong', () => {
  it('catches a stranger being served the file', async () => {
    const { under } = await app();
    const leaky = broken(under, (r, { who }) =>
      who === STRANGER ? { status: 200, headers: r.headers, body: new TextEncoder().encode('AUDIT BODY, 26 chars long.') } : r,
    );
    const report = await run(leaky);
    assert.equal(outcomeOf(report, 'a stranger cannot read it').outcome, 'fail');
    assert.equal(report.ok, false);
  });

  it('catches a 403 used where a 404 belongs', async () => {
    const { under } = await app();
    const oracle = broken(under, (r, { who }) =>
      who === STRANGER && r.status === 404 ? { ...r, status: 403 } : r,
    );
    const report = await run(oracle);
    const check = outcomeOf(report, 'WITHOUT confirming the file exists');
    assert.equal(check.outcome, 'fail');
    assert.match(check.why ?? '', /oracle/i);
  });

  it('catches an anonymous caller being served', async () => {
    const { under } = await app();
    const open = broken(under, (r, { who }) =>
      who === null ? { status: 200, headers: r.headers, body: new Uint8Array(3) } : r,
    );
    assert.equal(outcomeOf(await run(open), 'anonymous caller').outcome, 'fail');
  });

  it('catches an unknown id degrading to anonymous', async () => {
    const { under } = await app();
    const degrading = broken(under, (r, { who }) =>
      who !== null && who !== OWNER && who !== STRANGER
        ? { status: 200, headers: r.headers, body: new Uint8Array(3) }
        : r,
    );
    assert.equal(outcomeOf(await run(degrading), 'unknown user id').outcome, 'fail');
  });

  it('catches a stripped nosniff header, which is what a proxy does', async () => {
    const { under } = await app();
    const stripped = broken(under, (r) => {
      const { 'x-content-type-options': _gone, ...rest } = r.headers;
      return { ...r, headers: rest };
    });
    assert.equal(outcomeOf(await run(stripped), 'nosniff').outcome, 'fail');
  });

  it('catches user content served inline', async () => {
    const { under } = await app();
    const inline = broken(under, (r) => ({
      ...r,
      headers: { ...r.headers, 'content-disposition': 'inline; filename="x.txt"' },
    }));
    assert.equal(outcomeOf(await run(inline), 'as an attachment').outcome, 'fail');
  });

  it('catches a publicly cacheable authorized response', async () => {
    const { under } = await app();
    const cacheable = broken(under, (r) => ({
      ...r,
      headers: { ...r.headers, 'cache-control': 'public, max-age=31536000' },
    }));
    assert.equal(outcomeOf(await run(cacheable), 'publicly cacheable').outcome, 'fail');
  });

  it('catches a 416 for a range that should have been ignored', async () => {
    const { under } = await app();
    const wrong416 = broken(under, (r, { range }) =>
      range === 'bytes=9-4' ? { status: 416, headers: r.headers, body: new Uint8Array() } : r,
    );
    assert.equal(outcomeOf(await run(wrong416), 'INVALID range').outcome, 'fail');
  });

  it('catches a 416 that does not say how big the object is', async () => {
    const { under } = await app();
    const sizeless = broken(under, (r) => {
      if (r.status !== 416) return r;
      const { 'content-range': _gone, ...rest } = r.headers;
      return { ...r, headers: rest };
    });
    assert.equal(outcomeOf(await run(sizeless), 'unsatisfiable range').outcome, 'fail');
  });

  it('catches access surviving revocation', async () => {
    const { under } = await app();
    let revoked = false;
    const sticky: IntegrationUnderTest = {
      ...under,
      async unshare(id, user) {
        revoked = true;
        await under.unshare!(id, user);
      },
      async get(url, who, extra) {
        const r = await under.get(url, who, extra);
        // The shape of a redirect to a presigned URL that outlives the grant.
        if (revoked && who === STRANGER) {
          return { status: 200, headers: r.headers, body: new Uint8Array(5) };
        }
        return r;
      },
    };
    const check = outcomeOf(await run(sticky), 'revocation');
    assert.equal(check.outcome, 'fail');
    assert.match(check.why ?? '', /presigned/i);
  });

  it('reports a harness it cannot start as its own problem, not as a finding', async () => {
    const report = await auditIntegration({
      owner: OWNER,
      stranger: STRANGER,
      app: {
        upload: () => Promise.reject(new Error('no upload route here')),
        get: () => Promise.resolve({ status: 500, headers: {}, body: new Uint8Array() }),
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 1, 'nothing should run after the upload fails');
    assert.match(report.checks[0]!.why ?? '', /not a finding about your application/i);
    assert.match(report.checks[0]!.detail, /no upload route here/);
  });

  it('stops after the owner cannot read, because every refusal below would pass', async () => {
    const { under } = await app();
    const refusesEverybody = broken(under, (r) => ({ ...r, status: 404, body: new Uint8Array() }));
    const report = await run(refusesEverybody);
    assert.equal(report.ok, false);
    const check = outcomeOf(report, 'the owner reads their own file');
    assert.equal(check.outcome, 'fail');
    assert.match(check.why ?? '', /refuses everybody/i);
    assert.equal(report.checks.length, 1);
  });
});
