/**
 * Adapter: Filelayer, driven through examples/vault/server.ts over real HTTP.
 *
 * The suite talks to the SAME artifact the benchmark counts. It does not use
 * the library API directly, because the thing under attack is the integration,
 * not the engine.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// TWO SOURCES, ONE ADAPTER. Imported plainly, this drives the working tree:
// packages/core/src and examples/vault, which is what the CI gate
// (`npm run adversarial`) checks on every commit. Imported as
// `filelayer.mjs?published`, it drives what a stranger installs: the
// @filelayer/core that benchmark/package.json pins, its compiled dist, and the
// examples/vault/server.ts that ships inside that tarball. The published example
// imports '../../src/index.ts'; that one line is rewritten to '@filelayer/core'
// so the example runs against the published build rather than the TypeScript
// sources beside it. Nothing else in the file changes, and the rewrite fails
// loudly if that line is not there exactly once.
const PUBLISHED = new URL(import.meta.url).searchParams.has('published');
const HERE = dirname(fileURLToPath(import.meta.url));

async function loadLib() {
  if (!PUBLISHED) {
    const { createTestDb } = await import('../../../packages/core/src/db.ts');
    const { MemoryStorage } = await import('../../../packages/core/src/storage.ts');
    const { createVaultApp } = await import('../../../examples/vault/server.ts');
    return { createTestDb, MemoryStorage, createVaultApp, version: 'working tree' };
  }
  const bench = join(HERE, '..', '..');
  const req = createRequire(join(bench, 'package.json'));
  const pkgDir = dirname(req.resolve('@filelayer/core/package.json'));
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const src = readFileSync(join(pkgDir, 'examples', 'vault', 'server.ts'), 'utf8');
  const from = "from '../../src/index.ts';";
  if (src.split(from).length !== 2) {
    throw new Error(`published examples/vault/server.ts does not import ${from} exactly once; the rewrite would be a guess`);
  }
  const outDir = join(bench, '.published', `vault-${version}`);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'server.ts');
  writeFileSync(out, src.replace(from, "from '@filelayer/core';"));
  const core = await import(pathToFileURL(req.resolve('@filelayer/core')).href);
  const { createVaultApp } = await import(pathToFileURL(out).href);
  return { createTestDb: core.createTestDb, MemoryStorage: core.MemoryStorage, createVaultApp, version };
}
const { createTestDb, MemoryStorage, createVaultApp, version } = await loadLib();

const b64 = (s) => Buffer.from(s).toString('base64');

export const meta = {
  name: 'filelayer',
  executable: true,
  singleBackend: true,
  note: PUBLISHED
    ? `@filelayer/core ${version} from npm: its dist, and the examples/vault/server.ts in its tarball, over HTTP, PGlite + MemoryStorage`
    : 'examples/vault/server.ts in this working tree over HTTP, PGlite + MemoryStorage',
};

export async function create() {
  const { db } = await createTestDb();
  const server = createVaultApp(db, new MemoryStorage());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { as, body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(as ? { 'x-actor-id': as } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bytes */
    }
    const headers = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, json, text, headers, raw };
  };

  const actor = async (name) => (await call('POST', '/actors', { body: { externalId: name } })).json.id;

  // ---- the world every attack runs against --------------------------------
  const alice = await actor('alice');      // org A owner
  const adam = await actor('adam');        // org A admin
  const mallory = await actor('mallory');  // org A member, no grants
  const bob = await actor('bob');          // org B owner
  const eve = await actor('eve');          // org B member -- the attacker

  const orgA = (await call('POST', '/orgs', { body: { externalId: 'acme', ownerActorId: alice } })).json.id;
  const orgB = (await call('POST', '/orgs', { body: { externalId: 'beta', ownerActorId: bob } })).json.id;
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { actorId: adam, role: 'admin' } });
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { actorId: mallory, role: 'member' } });
  await call('POST', `/orgs/${orgB}/members`, { as: bob, body: { actorId: eve, role: 'member' } });

  const upload = async (name, marker, extra = {}) =>
    (
      await call('POST', `/orgs/${orgA}/files`, {
        as: alice,
        body: { name, contentType: 'text/plain', contentBase64: b64(marker), ...extra },
      })
    ).json.id;

  // Org-visible, so the baselines' "every member reads every org document"
  // model is what we compare against on the shared documents.
  const docA = await upload('a.txt', 'DOC-A-SECRET', { visibility: 'org' });
  const docA2 = await upload('a2.txt', 'DOC-A2-MARKER', { visibility: 'org' });
  const docAPrivate = await upload('private.txt', 'OWNER-ONLY', {});
  const docAExpired = await upload('exp.txt', 'EXPIRED', { visibility: 'org' });
  await db.query(`UPDATE file SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
    docAExpired,
  ]);

  const w = {
    alice, adam, mallory, bob, eve,
    orgA, orgB,
    docA, docA2, docAPrivate, docAExpired,
    docA2Marker: 'DOC-A2-MARKER',
    ghostUser: '00000000-0000-4000-8000-0000000000ee',
    ghostDoc: '00000000-0000-4000-8000-0000000000aa',
    ghostDocs: Array.from(
      { length: 8 },
      (_, i) => `00000000-0000-4000-8000-0000000000${(0xb0 + i).toString(16)}`,
    ),
  };

  return {
    w,
    singleBackend: true,
    close: async () => new Promise((r) => server.close(r)),

    read: ({ as, doc }) => call('GET', `/files/${doc}`, { as }),
    list: async ({ as, org }) => {
      const r = await call('GET', `/orgs/${org}/files`, { as });
      return { status: r.status, ids: (r.json?.files ?? []).map((f) => f.id) };
    },
    del: ({ as, doc }) => call('DELETE', `/files/${doc}`, { as }),

    share: async ({ as, doc, opts }) => {
      const r = await call('POST', `/files/${doc}/shares`, {
        as,
        body: {
          ...(opts.expiresInSec ? { expiresInHours: opts.expiresInSec / 3600 } : {}),
          ...(opts.maxDownloads ? { maxDownloads: opts.maxDownloads } : {}),
          ...(opts.password ? { password: opts.password } : {}),
        },
      });
      return { status: r.status, token: r.json?.secret, shareId: r.json?.grantId };
    },
    redeem: async ({ token, password, targetDoc }) => {
      // `targetDoc` is the confused-deputy probe: there is no way to aim a
      // Filelayer link at another file, because the file is not in the URL.
      // Redeeming it and comparing the bytes is the honest test.
      void targetDoc;
      const r = await call('POST', `/d/${token}`, { body: { password: password ?? undefined } });
      return {
        status: r.status,
        body: r.text,
        headers: r.headers,
        deliveredBytes: r.status === 200,
      };
    },
    revoke: ({ as, shareId }) => call('DELETE', `/shares/${shareId}`, { as }),
    expireShare: async ({ shareId }) => {
      await db.query(`UPDATE file_grant SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
        shareId,
      ]);
      return { status: 204 };
    },
    shareState: async ({ shareId }) => {
      const { rows } = await db.query(`SELECT download_count FROM file_grant WHERE id = $1`, [shareId]);
      return { downloadCount: Number(rows[0]?.download_count ?? 0) };
    },
    listShares: async ({ as, doc }) => {
      const r = await call('GET', `/files/${doc}/shares`, { as });
      return { status: r.status, shares: r.json };
    },

    setRole: ({ as, org, target, role }) =>
      call('POST', `/orgs/${org}/members`, { as, body: { actorId: target, role } }),

    audit: async ({ as, org }) => {
      const r = await call('GET', `/orgs/${org}/audit`, { as });
      return { status: r.status, events: Array.isArray(r.json) ? r.json : [] };
    },
    auditEvents: async ({ org }) => {
      const { rows } = await db.query(
        `SELECT action, decision, reason FROM audit_event WHERE org_id = $1`,
        [org],
      );
      return rows;
    },
    countAudit: async ({ org }) => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE org_id IS NOT DISTINCT FROM $1`,
        [org],
      );
      return Number(rows[0].n);
    },

    uploadHtml: async ({ org }) => {
      const r = await call('POST', `/orgs/${org}/files`, {
        as: alice,
        body: {
          name: 'evil.html',
          contentType: 'text/html',
          contentBase64: b64('<script>alert(document.cookie)</script>'),
          visibility: 'org',
        },
      });
      return { doc: r.json.id };
    },
    uploadNamed: async ({ org, name }) => {
      const r = await call('POST', `/orgs/${org}/files`, {
        as: alice,
        body: { name, contentType: 'text/plain', contentBase64: b64('x'), visibility: 'org' },
      });
      return { doc: r.json.id };
    },

    /**
     * Delegation: mint an actor grant carrying {read, share}, then try to use
     * it to mint a child carrying {delete}. Only this implementation has a
     * delegation model at all; the others record n/a, which is not a pass.
     */
    delegate: async () => {
      const parent = await call('POST', `/files/${docA}/shares`, {
        as: alice,
        body: { actorId: mallory },
      });
      if (parent.status !== 201) {
        return { unsupported: true, detail: `could not mint the parent grant: ${parent.status}` };
      }
      // The HTTP surface only mints read grants, so go at the model directly:
      // this is the attack a developer with database access, or a second
      // endpoint, would have.
      try {
        await db.query(
          `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id,
                                   capabilities)
           VALUES ($1,$2,$3,'actor',$4,'{read,delete}'::grant_capability[])`,
          [docA, orgA, parent.json.grantId, eve],
        );
        return { amplified: true, detail: 'a delegated grant carried more than its parent held' };
      } catch (e) {
        return {
          amplified: false,
          detail: `refused by the database itself: ${String(e.message).split(':')[0]}`,
        };
      }
    },
  };
}
