/**
 * Tamper-evident per-org SHA-256 hash chain. Substantively identical to
 * `../baseline-raw-s3/src/audit.mjs`; neither platform provides any of it.
 *
 * EXTRA HAZARD ON VERCEL: appends must be serialised per org or the chain
 * forks. On a long-lived Node server that is a row lock inside a transaction.
 * On Vercel Functions there is no long-lived process, concurrency is elastic
 * and invisible, and the serverless Postgres drivers most Vercel projects use
 * (`@neondatabase/serverless` over HTTP) do not expose interactive
 * transactions at all. The correct fix is to push the whole append into a
 * single atomic SQL statement, which is what `appendAudit` below does.
 */
import crypto from 'node:crypto';
import { sql } from './db';

const CHAIN_GENESIS = '0'.repeat(64);

export type AuditInput = {
  orgId: string;
  actorKind: 'user' | 'anonymous' | 'system';
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata?: Record<string, unknown>;
};

function canonical(e: {
  org_id: string; org_seq: number; actor_kind: string; actor_id: string | null;
  action: string; subject_type: string; subject_id: string;
  metadata: unknown; at: string;
}) {
  return JSON.stringify([
    e.org_id, e.org_seq, e.actor_kind, e.actor_id, e.action,
    e.subject_type, e.subject_id, e.metadata, e.at,
  ]);
}

function digest(prevHash: string, entry: Parameters<typeof canonical>[0]) {
  return crypto.createHash('sha256').update(prevHash).update(canonical(entry)).digest('hex');
}

/**
 * Reads the chain tip and appends. The UNIQUE (org_id, org_seq) constraint is
 * what actually makes this safe: two concurrent invocations that read the same
 * tip will both compute org_seq = N, and exactly one INSERT survives. The
 * loser retries.
 *
 * DOC GAP / HAZARD: this retry loop is load-bearing and easy to omit. Without
 * it, a concurrent append surfaces as a raw unique-violation 500 and the event
 * is simply never recorded — a silently incomplete audit trail, which is worse
 * than a loud failure for a compliance feature.
 */
export async function appendAudit(input: AuditInput, attempt = 0): Promise<{ orgSeq: number; hash: string }> {
  const tip = await sql`
    SELECT org_seq, hash FROM audit_log
     WHERE org_id = ${input.orgId} ORDER BY org_seq DESC LIMIT 1
  `;
  const prevHash: string = tip[0]?.hash ?? CHAIN_GENESIS;
  const orgSeq = (tip[0] ? Number(tip[0].org_seq) : 0) + 1;
  const at = new Date().toISOString();
  const metadata = input.metadata ?? {};

  const entry = {
    org_id: input.orgId,
    org_seq: orgSeq,
    actor_kind: input.actorKind,
    actor_id: input.actorId,
    action: input.action,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    metadata,
    at,
  };
  const hash = digest(prevHash, entry);

  try {
    await sql`
      INSERT INTO audit_log
        (org_id, org_seq, actor_kind, actor_id, action, subject_type, subject_id,
         metadata, at, prev_hash, hash)
      VALUES (${input.orgId}, ${orgSeq}, ${input.actorKind}, ${input.actorId},
              ${input.action}, ${input.subjectType}, ${input.subjectId},
              ${JSON.stringify(metadata)}::jsonb, ${at}, ${prevHash}, ${hash})
    `;
  } catch (err) {
    const msg = String((err as Error).message ?? '');
    if (msg.includes('audit_log_org_id_org_seq_key') && attempt < 5) {
      return appendAudit(input, attempt + 1);
    }
    throw err;
  }
  return { orgSeq, hash };
}

export async function verifyChain(orgId: string) {
  const rows = await sql`
    SELECT org_id, org_seq, actor_kind, actor_id, action, subject_type, subject_id,
           metadata, at, prev_hash, hash
      FROM audit_log WHERE org_id = ${orgId} ORDER BY org_seq ASC
  `;
  let prevHash = CHAIN_GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Number(r.org_seq) !== i + 1) return { ok: false, brokenAt: i + 1, reason: 'sequence_gap' };
    if (r.prev_hash !== prevHash) {
      return { ok: false, brokenAt: Number(r.org_seq), reason: 'prev_hash_mismatch' };
    }
    const entry = {
      org_id: r.org_id,
      org_seq: Number(r.org_seq),
      actor_kind: r.actor_kind,
      actor_id: r.actor_id,
      action: r.action,
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      metadata: r.metadata,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    };
    if (digest(prevHash, entry) !== r.hash) {
      return { ok: false, brokenAt: Number(r.org_seq), reason: 'hash_mismatch' };
    }
    prevHash = r.hash;
  }
  return { ok: true, entries: rows.length, tip: prevHash };
}
