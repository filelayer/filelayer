/**
 * Adapter: baseline-supabase, driven through its own application functions
 * against real Postgres RLS in PGlite (Config A -- the baseline's default).
 *
 * There is no HTTP layer in this baseline, by design -- the artifact is a
 * library of functions. So the adapter calls those functions and maps thrown
 * errors to statuses. NOTHING IN THE BASELINE IS MODIFIED.
 *
 * Where Supabase's model differs from the scenario in a way that makes an
 * attack inexpressible (no per-file visibility axis; no file-level expiry; no
 * delegation), the attack records n/a with a reason. That is not a pass and it
 * is not a criticism.
 */
import { boot } from '../../baseline-supabase/test/setup.js';
import {
  uploadDocument,
  listDocuments,
  downloadAsMember,
  softDeleteDocument,
  changeMemberRole,
  readAuditLog,
} from '../../baseline-supabase/src/app/vault.js';
import {
  createShareLink,
  revokeShareLink,
  redeemShareLink,
} from '../../baseline-supabase/src/app/share.js';

export const meta = {
  name: 'supabase',
  executable: true,
  singleBackend: true,
  note: 'real RLS in PGlite under SET LOCAL ROLE authenticated; Config A (the default)',
};

/** Turn a thrown RLS/permission failure into a status the suite can compare. */
async function attempt(fn) {
  try {
    const value = await fn();
    return { status: 200, value };
  } catch (e) {
    return { status: e?.status ?? 403, value: null, error: String(e?.message ?? e) };
  }
}

export async function create() {
  const { db, sb, orgA, orgB, u, tok } = await boot();

  const enc = (s) => new TextEncoder().encode(s);

  const docA = (
    await uploadDocument(sb, tok.alice, {
      orgId: orgA,
      filename: 'a.txt',
      bytes: enc('DOC-A-SECRET'),
      mimeType: 'text/plain',
    })
  ).documentId;
  const docA2 = (
    await uploadDocument(sb, tok.alice, {
      orgId: orgA,
      filename: 'a2.txt',
      bytes: enc('DOC-A2-MARKER'),
      mimeType: 'text/plain',
    })
  ).documentId;

  // Map the suite's role names onto this baseline's users.
  const tokenOf = new Map([
    [u.alice, tok.alice],
    [u.adam, tok.adam],
    [u.mia, tok.mia],
    [u.vera, tok.vera],
    [u.bob, tok.bob],
    [u.eve, tok.eve],
  ]);

  const w = {
    alice: u.alice,
    adam: u.adam,
    mallory: u.mia,
    bob: u.bob,
    eve: u.eve,
    orgA,
    orgB,
    docA,
    docA2,
    docAPrivate: null, // every org member reads every org document, by design
    docAExpired: null, // no file-level expiry in this baseline
    docA2Marker: 'DOC-A2-MARKER',
    ghostUser: '00000000-0000-4000-8000-0000000000ee',
    ghostDoc: '00000000-0000-4000-8000-0000000000aa',
    ghostDocs: Array.from(
      { length: 8 },
      (_, i) => `00000000-0000-4000-8000-0000000000${(0xb0 + i).toString(16)}`,
    ),
  };

  const shareTokens = new Map(); // shareId -> token, so revoke/expire can find it

  const countAudit = async (org) => {
    if (org === null) return 0; // no system chain in this baseline
    const { rows } = await db.query(`select count(*)::int as n from public.audit_log where org_id=$1`, [
      org,
    ]);
    return Number(rows[0].n);
  };

  return {
    w,
    singleBackend: true,
    close: async () => {
      try {
        await db.close();
      } catch {
        /* already closed */
      }
    },

    read: async ({ as, org, doc }) => {
      const t = tokenOf.get(as);
      if (!t) {
        // A forged identity: mint a token for a user id that does not exist.
        // This is exactly what a stolen/forged JWT looks like to the platform.
        const forged = sb.issueAccessToken(as);
        const r = await attempt(() => downloadAsMember(sb, forged, org, doc));
        return { status: r.status === 200 ? 200 : (r.status ?? 403) };
      }
      const r = await attempt(() => downloadAsMember(sb, t, org, doc));
      return { status: r.status, body: r.value ? new TextDecoder().decode(r.value) : null };
    },
    list: async ({ as, org }) => {
      const r = await attempt(() => listDocuments(sb, tokenOf.get(as), org));
      return { status: r.status, ids: (r.value ?? []).map((d) => d.id) };
    },
    del: async ({ as, org, doc }) => {
      const r = await attempt(() => softDeleteDocument(sb, tokenOf.get(as), org, doc));
      return { status: r.status };
    },

    share: async ({ as, org, doc, opts }) => {
      const r = await attempt(() =>
        createShareLink(sb, tokenOf.get(as), {
          orgId: org,
          documentId: doc,
          expiresInSec: opts.expiresInSec ?? 3600,
          password: opts.password ?? null,
          maxDownloads: opts.maxDownloads ?? null,
        }),
      );
      if (r.status !== 200) return { status: r.status };
      const token = r.value.url.split('/').pop();
      shareTokens.set(r.value.id, token);
      return { status: 200, token, shareId: r.value.id };
    },
    redeem: async ({ token, password }) => {
      const r = await attempt(() =>
        redeemShareLink(sb, { shareToken: token, password: password ?? null }),
      );
      if (r.status !== 200 || !r.value?.ok) return { status: 403 };
      // Supabase's redeem returns a SIGNED URL, not bytes. Follow it, because
      // "did the attacker get the bytes" is the only question that matters.
      const bytes = await attempt(() => sb.fetchSignedUrl(r.value.signedUrl));
      return {
        status: bytes.status,
        body: bytes.value ? new TextDecoder().decode(bytes.value) : null,
        // No application response headers exist: the object store serves the
        // bytes. This is recorded as n/a by the header-dependent attacks.
        headers: null,
        deliveredBytes: false,
        residualWindowSec: r.value.residualRevocationWindowSec,
      };
    },
    revoke: async ({ as, org, shareId }) => {
      const r = await attempt(() =>
        revokeShareLink(sb, tokenOf.get(as), { orgId: org, shareLinkId: shareId }),
      );
      return { status: r.status };
    },
    expireShare: async ({ shareId }) => {
      await db.query(
        `update public.share_links set expires_at = now() - interval '1 hour' where id=$1`,
        [shareId],
      );
      return { status: 204 };
    },
    shareState: async ({ shareId }) => {
      const { rows } = await db.query(
        `select download_count from public.share_links where id=$1`,
        [shareId],
      );
      return { downloadCount: Number(rows[0]?.download_count ?? 0) };
    },
    listShares: async () => ({ status: 404, shares: [] }),

    setRole: async ({ as, org, target, role }) => {
      const r = await attempt(() => changeMemberRole(sb, tokenOf.get(as), org, target, role));
      return { status: r.status };
    },

    audit: async ({ as, org }) => {
      const r = await attempt(() => readAuditLog(sb, tokenOf.get(as), org));
      return { status: r.status, events: r.value ?? [] };
    },
    auditEvents: async ({ org }) => {
      const { rows } = await db.query(`select action from public.audit_log where org_id=$1`, [org]);
      return rows;
    },
    countAudit: ({ org }) => countAudit(org),

    uploadHtml: async ({ org }) => {
      const r = await uploadDocument(sb, tok.alice, {
        orgId: org,
        filename: 'evil.html',
        bytes: enc('<script>x</script>'),
        mimeType: 'text/html',
      });
      return { doc: r.documentId };
    },
    uploadNamed: async ({ org, name }) => {
      const r = await attempt(() =>
        uploadDocument(sb, tok.alice, {
          orgId: org,
          filename: name,
          bytes: enc('x'),
          mimeType: 'text/plain',
        }),
      );
      return r.status === 200
        ? { doc: r.value.documentId }
        : { unsupported: true, detail: `the hostile filename was rejected at upload: ${r.error}` };
    },

    delegate: async () => ({
      unsupported: true,
      detail:
        'no delegation model: a share link is a row with no lineage and no "pass it on" ' +
        'operation. Recorded as n/a, not as a defence.',
    }),
  };
}
