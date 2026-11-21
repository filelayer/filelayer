/**
 * THE 21 SHARED ATTACKS, AGAINST ANY IMPLEMENTATION OF THE CONTRACT.
 *
 * The attacks themselves are benchmark/adversarial/attacks.mjs, unchanged and
 * imported from there, so the productivity benchmark scores security with the
 * very suite the comparison page publishes. This file is only the adapter that
 * expresses each capability the suite asks for as contract HTTP requests.
 *
 * Where the existing adapters reached into a database, this one cannot, and
 * says how it gets the same fact over HTTP:
 *   - expireShare: the contract cannot move a share's clock. A share the
 *     attack asks to expire is created with expiresInSeconds = 1 and the
 *     adapter waits until it has passed.
 *   - shareState: the download count comes from the share listing.
 *   - countAudit / auditEvents: the operator view, GET /admin/audit.
 *
 * Only the 21 attacks every executed implementation could express on the
 * comparison page are scored (SHARED below). The others are recorded n/a
 * here exactly as there: the contract has no per-document visibility (A7), no
 * document expiry (C2), no delegation (D4); B7 and F3 are run and reported,
 * not scored, so the preregistered number stays the published 21.
 */
import { ATTACKS } from '../../adversarial/attacks.mjs';
import { buildWorld, tokenOf } from './client.mjs';

export const SHARED = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
  'C1', 'C3',
  'D1', 'D2', 'D3',
  'E1', 'E2',
  'F1', 'F2',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function adapterFor(c) {
  const w = await buildWorld(c);
  const shareDoc = new Map(); // shareId -> { org, doc, expiresAt }
  const impl = {
    w,
    client: c,
    singleBackend: true,
    read: ({ as, org, doc }) => c.call('GET', `/orgs/${org}/documents/${doc}`, { as }),
    list: async ({ as, org }) => {
      const r = await c.call('GET', `/orgs/${org}/documents`, { as });
      return { status: r.status, ids: (r.json?.documents ?? []).map((d) => d.id) };
    },
    del: ({ as, org, doc }) => c.call('DELETE', `/orgs/${org}/documents/${doc}`, { as }),
    share: async ({ as, org, doc, opts = {} }) => {
      const expiresInSeconds = opts.expiresInSec !== undefined && opts.expiresInSec <= 60 ? 1 : (opts.expiresInSec ?? 3600);
      const r = await c.call('POST', `/orgs/${org}/documents/${doc}/shares`, {
        as,
        body: {
          expiresInSeconds,
          ...(opts.maxDownloads ? { maxDownloads: opts.maxDownloads } : {}),
          ...(opts.password ? { password: opts.password } : {}),
        },
      });
      if (r.json?.id) shareDoc.set(r.json.id, { org, doc, expiresAt: r.json.expiresAt });
      return { status: r.status, token: tokenOf(r.json?.url), shareId: r.json?.id };
    },
    redeem: async ({ token, password }) => {
      const r = await c.call('GET', `/s/${token}`, {
        headers: password === undefined ? {} : { 'x-share-password': password },
      });
      return { status: r.status, body: r.text, headers: r.headers, deliveredBytes: r.status === 200 };
    },
    revoke: ({ as, org, shareId }) => c.call('DELETE', `/orgs/${org}/shares/${shareId}`, { as }),
    expireShare: async ({ shareId }) => {
      const s = shareDoc.get(shareId);
      const at = s?.expiresAt ? Date.parse(s.expiresAt) : Date.now() + 1000;
      await sleep(Math.max(0, at - Date.now()) + 1100);
      return { status: 204 };
    },
    shareState: async ({ shareId }) => {
      const s = shareDoc.get(shareId);
      const r = await c.call('GET', `/orgs/${s.org}/documents/${s.doc}/shares`, { as: w.alice });
      const row = (r.json?.shares ?? []).find((x) => x.id === shareId);
      return { downloadCount: Number(row?.downloadCount ?? 0) };
    },
    listShares: async ({ as, org, doc }) => {
      const r = await c.call('GET', `/orgs/${org ?? w.orgA}/documents/${doc ?? w.docA}/shares`, { as: as ?? w.alice });
      return { status: r.status, shares: r.json?.shares ?? [], raw: r.text };
    },
    setRole: ({ as, org, target, role }) => c.call('PUT', `/orgs/${org}/members/${target}`, { as, body: { role } }),
    audit: async ({ as, org }) => {
      const r = await c.call('GET', `/orgs/${org}/audit`, { as });
      return { status: r.status, events: r.json?.events ?? [] };
    },
    auditEvents: async ({ org }) => (await c.adminAudit()).filter((e) => e.orgId === org),
    countAudit: async ({ org }) => (await c.adminAudit()).filter((e) => (e.orgId ?? null) === org).length,
    uploadHtml: async () => ({ doc: await w.upload(w.alice, w.orgA, 'evil.html', 'text/html', '<script>alert(1)</script>') }),
    uploadNamed: async ({ name }) => ({ doc: await w.upload(w.alice, w.orgA, name, 'text/plain', 'x') }),
    delegate: async () => ({
      unsupported: true,
      detail: 'the contract has no delegation operation: a share link carries no authority to pass on',
    }),
  };
  return impl;
}

/**
 * POSITIVE CONTROLS. A1-A4 count any refusal as defended, so an implementation
 * that refused everything would defend them all (cold review). Before each, the
 * legitimate twin of the attack must work: the owner reads, lists or deletes
 * her own documents, and the attacker works in her own org. A failed control
 * scores the attack as not defended (`control_failed`). The shared attacks
 * themselves are unchanged.
 */
const CONTROLS = {
  async A1(impl, w) {
    const r = await impl.read({ w, as: w.alice, org: w.orgA, doc: w.docA });
    if (r.status !== 200 || r.text !== 'DOC-A-SECRET') return `the owner cannot read her document (status ${r.status})`;
    const own = await impl.list({ w, as: w.eve, org: w.orgB });
    if (own.status !== 200) return `the attacker cannot list her own org (status ${own.status})`;
    return null;
  },
  async A3(impl, w) {
    const r = await impl.list({ w, as: w.alice, org: w.orgA });
    if (r.status !== 200 || !(r.ids ?? []).includes(w.docA)) return `the owner's listing does not hold her document (status ${r.status})`;
    return null;
  },
  async A4(impl, w) {
    const r = await impl.del({ w, as: w.alice, org: w.orgA, doc: w.docA2 });
    if (r.status < 200 || r.status >= 300) return `the owner cannot delete her own document (status ${r.status})`;
    const gone = await impl.read({ w, as: w.alice, org: w.orgA, doc: w.docA2 });
    if (gone.status !== 404) return `a deleted document still answers ${gone.status}`;
    return null;
  },
};
CONTROLS.A2 = CONTROLS.A1;

/** Run every attack in a fresh world each, against a running implementation. */
export async function runAttacks(makeClient) {
  const results = [];
  for (const a of ATTACKS) {
    let verdict;
    try {
      const impl = await adapterFor(makeClient());
      const control = CONTROLS[a.id] ? await CONTROLS[a.id](impl, impl.w) : null;
      verdict = control
        ? { verdict: 'control_failed', detail: `positive control failed, so the refusal proves nothing: ${control}` }
        : await a.run(impl, impl.w);
    } catch (e) {
      verdict = { verdict: 'error', detail: String(e?.message ?? e).slice(0, 300) };
    }
    results.push({ id: a.id, name: a.name, severity: a.severity, scored: SHARED.includes(a.id), ...verdict });
  }
  const scored = results.filter((r) => r.scored);
  return {
    results,
    defended: scored.filter((r) => r.verdict === 'defended').length,
    of: scored.length,
    allDefended: scored.every((r) => r.verdict === 'defended'),
  };
}

/**
 * The attacks written after the freeze (late/README.md), scored apart from the
 * 21. Every *.mjs in late/ that exports ATTACKS; each attack in a fresh world.
 */
export async function runLateAttacks(makeClient) {
  const { readdirSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const dir = fileURLToPath(new URL('./late/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const results = [];
  for (const f of files) {
    const { ATTACKS: late = [] } = await import(pathToFileURL(dir + f).href);
    for (const a of late) {
      let verdict;
      try {
        const impl = await adapterFor(makeClient());
        verdict = await a.run(impl, impl.w);
      } catch (e) {
        verdict = { verdict: 'error', detail: String(e?.message ?? e).slice(0, 300) };
      }
      results.push({ id: a.id, name: a.name, severity: a.severity, file: f, ...verdict });
    }
  }
  const counted = results.filter((r) => r.verdict !== 'n/a');
  return { results, defended: counted.filter((r) => r.verdict === 'defended').length, of: counted.length };
}
