/**
 * THE SHARED ADVERSARIAL SUITE.
 *
 * This exists because the first round of measurement did not have one. There
 * were four independent attack suites written by four different authors, and
 * Filelayer's -- the densest by an order of magnitude -- was written by the
 * people who built the thing it tests. Under those conditions "failure modes
 * found by an adversarial suite" is not a comparable metric; it measures who
 * wrote the suite.
 *
 * This file is that suite. Every attack below is defined ONCE, in
 * implementation-neutral terms, and executed against every implementation that
 * can be executed at all.
 *
 * THE RULES IT PLAYS BY, so it cannot quietly favour Filelayer:
 *
 *  1. An attack is expressed against a small capability interface (read, list,
 *     share, redeem, revoke, setRole, audit). No attack may reference an
 *     implementation by name. Grep for "filelayer" in this file: zero hits
 *     outside this comment.
 *  2. An implementation that cannot express an attack records **n/a with a
 *     stated reason**, never a pass. "We do not have that feature" is not a
 *     defence and is not scored as one.
 *  3. `partial` is a real verdict and is used where a platform defends the
 *     property with a caveat (a residual window, a weaker artefact). It is
 *     scored separately from `defended`.
 *  4. Two implementations (Convex, Vercel Blob) have no executable form. They
 *     are recorded as **not-run**, not as passing and not as failing. Any
 *     claim about them in the report is a code-reading claim and is labelled
 *     as one.
 *
 * Each attack returns { verdict, detail }.
 *   defended  - the attack was refused, and refused for the right reason
 *   BREACH    - the attack succeeded
 *   partial   - refused, but with a caveat that matters
 *   n/a       - the implementation cannot express this attack
 */

/** @typedef {'defended'|'BREACH'|'partial'|'n/a'} Verdict */

const ok = (detail) => ({ verdict: 'defended', detail });
const breach = (detail) => ({ verdict: 'BREACH', detail });
const partial = (detail) => ({ verdict: 'partial', detail });
const na = (detail) => ({ verdict: 'n/a', detail });

/** A response is "success" if the implementation delivered or authorized it. */
const succeeded = (r) => r.status >= 200 && r.status < 400;

export const ATTACKS = [
  // ---------------------------------------------------------------------------
  // CROSS-TENANT ACCESS, BY EVERY ROUTE
  // ---------------------------------------------------------------------------
  {
    id: 'A1',
    name: 'cross-tenant read by document id',
    category: 'cross-tenant',
    severity: 'critical',
    requires: ['read'],
    async run(impl, w) {
      const r = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.docA });
      return succeeded(r)
        ? breach(`org-B member read org-A document (status ${r.status})`)
        : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'A2',
    name: 'cross-tenant read by naming the victim org on your own route',
    category: 'cross-tenant',
    severity: 'critical',
    requires: ['read'],
    async run(impl, w) {
      // The confused-deputy shape of A1: the attacker supplies a document id
      // from org A while claiming their OWN org in the path/args. An
      // implementation that trusts the caller-supplied org id and then loads
      // the document by id alone leaks here and not in A1.
      const r = await impl.read({ w, as: w.eve, org: w.orgB, doc: w.docA });
      return succeeded(r) ? breach(`status ${r.status}`) : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'A3',
    name: 'cross-tenant listing',
    category: 'cross-tenant',
    severity: 'critical',
    requires: ['list'],
    async run(impl, w) {
      const r = await impl.list({ w, as: w.eve, org: w.orgA });
      if (succeeded(r) && (r.ids ?? []).length > 0) {
        return breach(`listed ${r.ids.length} document(s) from another tenant`);
      }
      return ok(succeeded(r) ? 'returned an empty page' : `refused with ${r.status}`);
    },
  },
  {
    id: 'A4',
    name: 'cross-tenant delete',
    category: 'cross-tenant',
    severity: 'critical',
    requires: ['del', 'read'],
    async run(impl, w) {
      const r = await impl.del({ w, as: w.eve, org: w.orgA, doc: w.docA });
      if (succeeded(r)) return breach(`delete accepted with ${r.status}`);
      // ...and confirm the document survived, not merely that the call errored.
      const still = await impl.read({ w, as: w.alice, org: w.orgA, doc: w.docA });
      return succeeded(still)
        ? ok(`refused with ${r.status}; document still readable by its owner`)
        : breach('delete was refused but the document is gone');
    },
  },
  {
    id: 'A5',
    name: 'cross-tenant share minting (deputy mints a link over a foreign file)',
    category: 'confused-deputy',
    severity: 'critical',
    requires: ['share'],
    async run(impl, w) {
      const r = await impl.share({ w, as: w.eve, org: w.orgB, doc: w.docA, opts: {} });
      return succeeded(r)
        ? breach('minted a working share link over another tenant\'s document')
        : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'A6',
    name: 'cross-tenant audit read',
    category: 'cross-tenant',
    severity: 'high',
    requires: ['audit'],
    async run(impl, w) {
      const r = await impl.audit({ w, as: w.eve, org: w.orgA });
      if (succeeded(r) && (r.events ?? []).length > 0) {
        return breach(`read ${r.events.length} audit events from another tenant`);
      }
      return ok(succeeded(r) ? 'empty' : `refused with ${r.status}`);
    },
  },
  {
    id: 'A7',
    name: 'intra-tenant privilege: a member reads a document they were not given',
    category: 'cross-tenant',
    severity: 'high',
    requires: ['read'],
    async run(impl, w) {
      if (!w.docAPrivate) return na('this implementation has no per-file visibility axis');
      const r = await impl.read({ w, as: w.mallory, org: w.orgA, doc: w.docAPrivate });
      return succeeded(r)
        ? breach('a same-org member read an owner-private document')
        : ok(`refused with ${r.status}`);
    },
  },

  // ---------------------------------------------------------------------------
  // SHARE-LINK ATTACKS
  // ---------------------------------------------------------------------------
  {
    id: 'B1',
    name: 'confused deputy: a valid token for document 1 fetches document 2',
    category: 'confused-deputy',
    severity: 'critical',
    requires: ['share', 'redeem'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.redeem({ w, token: s.token, targetDoc: w.docA2 });
      if (!succeeded(r)) return ok(`refused with ${r.status}`);
      const bytes = r.body ?? '';
      return String(bytes).includes(w.docA2Marker)
        ? breach('a token bound to one document served another')
        : ok('the token served only the document it was minted for');
    },
  },
  {
    id: 'B2',
    name: 'revoked-URL replay',
    category: 'revocation',
    severity: 'critical',
    requires: ['share', 'redeem', 'revoke'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const first = await impl.redeem({ w, token: s.token });
      if (!succeeded(first)) return na(`the link did not work before revocation: ${first.status}`);
      await impl.revoke({ w, as: w.alice, org: w.orgA, shareId: s.shareId });
      const after = await impl.redeem({ w, token: s.token });
      if (succeeded(after)) return breach(`the revoked link still served bytes (${after.status})`);
      if (first.residualWindowSec) {
        return partial(
          `the gateway refuses immediately, but a signed URL already minted stays valid for ` +
            `${first.residualWindowSec}s after revocation`,
        );
      }
      return ok(`refused with ${after.status}, with no residual window`);
    },
  },
  {
    id: 'B3',
    name: 'cache replay: is a revoked download replayable from a cache?',
    category: 'revocation',
    severity: 'high',
    requires: ['share', 'redeem'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.redeem({ w, token: s.token });
      if (!succeeded(r)) return na(`redeem failed: ${r.status}`);
      const cc = (r.headers?.['cache-control'] ?? '').toLowerCase();
      if (!r.headers) {
        return na(
          r.headersNote ??
            'this implementation hands out a URL rather than bytes; the response headers ' +
              "that govern caching are the object store's, not the application's",
        );
      }
      if (!/no-store/.test(cc)) {
        return breach(
          `Cache-Control is "${cc || '(absent)'}" -- a revoked link is replayable from the ` +
            `recipient's disk cache or an intermediary, which defeats immediate revocation`,
        );
      }
      return /private/.test(cc)
        ? ok(`Cache-Control: ${cc}`)
        : partial(`no-store is set but "private" is not: ${cc}`);
    },
  },
  {
    id: 'B4',
    name: 'expired grant still redeems',
    category: 'expiry',
    severity: 'high',
    requires: ['share', 'redeem', 'expireShare'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: { expiresInSec: 60 } });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      await impl.expireShare({ w, shareId: s.shareId });
      const r = await impl.redeem({ w, token: s.token });
      return succeeded(r) ? breach(`expired link served bytes (${r.status})`) : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'B5',
    name: 'download-cap race: 20 concurrent redemptions against max=1',
    category: 'concurrency',
    severity: 'high',
    requires: ['share', 'redeem'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: { maxDownloads: 1 } });
      if (!succeeded(s)) return na(`could not create a capped share link: ${s.status}`);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => impl.redeem({ w, token: s.token }).catch(() => ({ status: 500 }))),
      );
      const granted = results.filter(succeeded).length;
      if (granted > 1) return breach(`${granted}/20 concurrent redemptions were granted against a cap of 1`);
      return ok(
        `${granted}/20 granted` +
          (impl.singleBackend
            ? ' (NOTE: the harness is a single database backend, so this exercises the ' +
              'interleaving form of the race and not lock contention)'
            : ''),
      );
    },
  },
  {
    id: 'B6',
    name: 'a wrong password consumes a download from the cap',
    category: 'share',
    severity: 'medium',
    requires: ['share', 'redeem', 'shareState'],
    async run(impl, w) {
      const s = await impl.share({
        w, as: w.alice, org: w.orgA, doc: w.docA,
        opts: { password: 'correct-horse', maxDownloads: 2 },
      });
      if (!succeeded(s)) return na(`could not create a password-protected link: ${s.status}`);
      for (let i = 0; i < 3; i++) await impl.redeem({ w, token: s.token, password: 'wrong' });
      const st = await impl.shareState({ w, shareId: s.shareId });
      return st.downloadCount > 0
        ? breach(`${st.downloadCount} download(s) burned by failed password attempts`)
        : ok('failed password attempts do not consume the cap');
    },
  },
  {
    id: 'B7',
    name: 'listing shares leaks the raw token',
    category: 'share',
    severity: 'high',
    requires: ['share', 'listShares'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.listShares({ w, as: w.alice, org: w.orgA, doc: w.docA });
      if (!succeeded(r)) return na(`no share-listing surface: ${r.status}`);
      return JSON.stringify(r.shares ?? []).includes(s.token)
        ? breach('"list what we have shared" returns working credentials')
        : ok('the token is not returned again after creation');
    },
  },

  // ---------------------------------------------------------------------------
  // ORACLES
  // ---------------------------------------------------------------------------
  {
    id: 'C1',
    name: 'existence oracle: a real document you cannot see vs one that does not exist',
    category: 'oracle',
    severity: 'medium',
    requires: ['read'],
    async run(impl, w) {
      const real = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.docA });
      const fake = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.ghostDoc });
      return real.status === fake.status
        ? ok(`both ${real.status}`)
        : breach(`real=${real.status} vs nonexistent=${fake.status}: the error surface enumerates`);
    },
  },
  {
    id: 'C2',
    name: 'lifecycle oracle: an expired/held document distinguishable to a stranger',
    category: 'oracle',
    severity: 'medium',
    requires: ['read'],
    async run(impl, w) {
      if (!w.docAExpired) return na('this implementation has no file-level expiry');
      const expired = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.docAExpired });
      const fake = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.ghostDoc });
      return expired.status === fake.status
        ? ok(`both ${expired.status}`)
        : breach(`expired=${expired.status} vs nonexistent=${fake.status}`);
    },
  },
  {
    id: 'C3',
    name: 'identity oracle: a forged (well-formed, unregistered) caller id',
    category: 'oracle',
    severity: 'high',
    requires: ['read'],
    async run(impl, w) {
      // A registered stranger and an unregistered one must be answered
      // identically. If they are not, the error surface enumerates USERS, and
      // a 500 additionally means the denial was probably never recorded.
      const known = await impl.read({ w, as: w.eve, org: w.orgA, doc: w.docA });
      const forged = await impl.read({ w, as: w.ghostUser, org: w.orgA, doc: w.docA });
      if (forged.status >= 500) {
        return breach(
          `a forged identity produces ${forged.status} where a real stranger gets ` +
            `${known.status}: an actor-existence oracle, and a 5xx usually means the ` +
            `denial was not recorded either`,
        );
      }
      return known.status === forged.status
        ? ok(`both ${known.status}`)
        : partial(`known stranger=${known.status}, forged identity=${forged.status}`);
    },
  },
  {
    id: 'C4',
    name: 'enumeration leaves no trace',
    category: 'audit',
    severity: 'high',
    requires: ['read', 'countAudit'],
    async run(impl, w) {
      const before = await impl.countAudit({ w, org: w.orgA });
      const beforeSystem = await impl.countAudit({ w, org: null });
      for (const doc of w.ghostDocs) await impl.read({ w, as: w.eve, org: w.orgA, doc });
      const after = await impl.countAudit({ w, org: w.orgA });
      const afterSystem = await impl.countAudit({ w, org: null });
      const recorded = after - before + (afterSystem - beforeSystem);
      if (recorded === 0) {
        return breach(`${w.ghostDocs.length} probes at unknown document ids produced 0 audit events`);
      }
      return recorded >= w.ghostDocs.length
        ? ok(`${recorded} events for ${w.ghostDocs.length} probes`)
        : partial(`${recorded} events for ${w.ghostDocs.length} probes`);
    },
  },

  // ---------------------------------------------------------------------------
  // PRIVILEGE ESCALATION
  // ---------------------------------------------------------------------------
  {
    id: 'D1',
    name: 'self-promotion: a member sets their own role to admin',
    category: 'escalation',
    severity: 'critical',
    requires: ['setRole'],
    async run(impl, w) {
      const r = await impl.setRole({ w, as: w.mallory, org: w.orgA, target: w.mallory, role: 'admin' });
      return succeeded(r) ? breach(`accepted with ${r.status}`) : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'D2',
    name: 'admin promotes themselves to owner',
    category: 'escalation',
    severity: 'high',
    requires: ['setRole'],
    async run(impl, w) {
      const r = await impl.setRole({ w, as: w.adam, org: w.orgA, target: w.adam, role: 'owner' });
      return succeeded(r)
        ? breach('admin is owner with an extra step')
        : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'D3',
    name: 'outsider adds themselves to a tenant',
    category: 'escalation',
    severity: 'critical',
    requires: ['setRole'],
    async run(impl, w) {
      const r = await impl.setRole({ w, as: w.eve, org: w.orgA, target: w.eve, role: 'owner' });
      return succeeded(r) ? breach(`accepted with ${r.status}`) : ok(`refused with ${r.status}`);
    },
  },
  {
    id: 'D4',
    name: 'escalation via delegation: pass on more authority than you hold',
    category: 'escalation',
    severity: 'high',
    requires: ['delegate'],
    async run(impl, w) {
      const r = await impl.delegate({ w });
      if (r.unsupported) return na(r.detail);
      return r.amplified ? breach(r.detail) : ok(r.detail);
    },
  },

  // ---------------------------------------------------------------------------
  // AUDIT COMPLETENESS
  // ---------------------------------------------------------------------------
  {
    id: 'E1',
    name: 'a denied access is recorded',
    category: 'audit',
    severity: 'high',
    requires: ['read', 'countAudit'],
    async run(impl, w) {
      const before = await impl.countAudit({ w, org: w.orgA });
      const beforeSystem = await impl.countAudit({ w, org: null });
      await impl.read({ w, as: w.eve, org: w.orgA, doc: w.docA });
      const delta =
        (await impl.countAudit({ w, org: w.orgA })) - before +
        ((await impl.countAudit({ w, org: null })) - beforeSystem);
      return delta > 0
        ? ok(`${delta} event(s) recorded for the refused access`)
        : breach('a cross-tenant access attempt left no record anywhere');
    },
  },
  {
    id: 'E2',
    name: 'a byte delivery is recorded as a delivery, not as a URL issuance',
    category: 'audit',
    severity: 'high',
    requires: ['share', 'redeem', 'auditEvents'],
    async run(impl, w) {
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: w.docA, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.redeem({ w, token: s.token });
      if (!succeeded(r)) return na(`redeem failed: ${r.status}`);
      const events = await impl.auditEvents({ w, org: w.orgA });
      const delivered = events.some((e) => /download|read/i.test(e.action));
      if (!delivered) return breach('the download produced no audit event');
      return r.deliveredBytes
        ? ok('the event records bytes actually served by the implementation')
        : partial(
            'an event exists, but the implementation issued a URL rather than serving bytes, ' +
              'so the log records that a URL was ISSUED and cannot record whether it was used',
          );
    },
  },

  // ---------------------------------------------------------------------------
  // DELIVERY
  // ---------------------------------------------------------------------------
  {
    id: 'F1',
    name: 'stored XSS: user-uploaded HTML served renderable from our own origin',
    category: 'delivery',
    severity: 'high',
    requires: ['uploadHtml', 'share', 'redeem'],
    async run(impl, w) {
      const doc = await impl.uploadHtml({ w, as: w.alice, org: w.orgA });
      if (doc.unsupported) return na(doc.detail);
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: doc.doc, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.redeem({ w, token: s.token });
      if (!succeeded(r)) return na(`redeem failed: ${r.status}`);
      if (!r.headers) return na(r.headersNote ?? 'bytes are delivered by the object store, not the application');
      const cd = (r.headers['content-disposition'] ?? '').toLowerCase();
      const ct = (r.headers['content-type'] ?? '').toLowerCase();
      const nosniff = (r.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff';
      if (!cd.startsWith('attachment')) {
        return breach(`served inline as ${ct || '(no type)'} -- stored XSS in the app's own origin`);
      }
      return nosniff
        ? ok(`attachment + nosniff (content-type ${ct})`)
        : partial('attachment is set but nosniff is not');
    },
  },
  {
    id: 'F3',
    name: 'stored XSS on the AUTHENTICATED read path',
    category: 'delivery',
    severity: 'high',
    requires: ['uploadHtml', 'read'],
    async run(impl, w) {
      // Distinct from F1: the share path and the in-app read path are written
      // by different hands and are wrong independently. A security review of an
      // earlier revision found the defect on the read path specifically, where a
      // member's own browser renders another member's uploaded HTML inside the
      // application's session.
      const doc = await impl.uploadHtml({ w, as: w.alice, org: w.orgA });
      if (doc.unsupported) return na(doc.detail);
      const r = await impl.read({ w, as: w.alice, org: w.orgA, doc: doc.doc });
      if (!succeeded(r)) return na(`read failed: ${r.status}`);
      if (!r.headers) return na(r.headersNote ?? 'bytes are delivered by the object store, not the application');
      const cd = (r.headers['content-disposition'] ?? '').toLowerCase();
      const nosniff = (r.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff';
      if (!cd.startsWith('attachment')) {
        return breach(
          `the in-app read serves user HTML as ${r.headers['content-type']} with ` +
            `Content-Disposition "${cd || '(absent)'}": stored XSS in the app's own origin, ` +
            `with the victim's session attached`,
        );
      }
      return nosniff ? ok('attachment + nosniff') : partial('attachment but no nosniff');
    },
  },
  {
    id: 'F2',
    name: 'response splitting through a hostile filename',
    category: 'delivery',
    severity: 'medium',
    requires: ['uploadNamed', 'share', 'redeem'],
    async run(impl, w) {
      const doc = await impl.uploadNamed({
        w, as: w.alice, org: w.orgA,
        name: 'a\r\nX-Injected: yes\r\nb.txt',
      });
      if (doc.unsupported) return na(doc.detail);
      const s = await impl.share({ w, as: w.alice, org: w.orgA, doc: doc.doc, opts: {} });
      if (!succeeded(s)) return na(`could not create a share link: ${s.status}`);
      const r = await impl.redeem({ w, token: s.token });
      if (!r.headers) return na(r.headersNote ?? 'bytes are delivered by the object store, not the application');
      if (r.headers['x-injected']) return breach('a filename injected a response header');
      if (r.status >= 500) {
        return partial(
          'no header was injected -- but only because the HTTP runtime refused to write the ' +
            'value. The application interpolated the filename unescaped, so every share ' +
            'download of that document now returns 500: an uploaded filename is a permanent ' +
            'denial of service against its own share links.',
        );
      }
      if (!succeeded(r)) return ok(`the hostile name was rejected upstream (${r.status})`);
      return ok('the filename is encoded, not interpolated');
    },
  },
];

export const CATEGORIES = [...new Set(ATTACKS.map((a) => a.category))];
