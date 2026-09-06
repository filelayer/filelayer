import crypto from 'node:crypto';

/**
 * Tamper-evident audit trail implemented as a per-org SHA-256 hash chain.
 *
 * Each entry's hash covers (prev_hash || canonical JSON of the entry fields).
 * Any insertion, deletion or mutation of an entry breaks the chain from that
 * point on and `verifyChain` detects it.
 *
 * Honest limits of this design (see REPORT.md §7):
 *  - It is tamper-EVIDENT, not tamper-PROOF. Anyone with UPDATE rights on the
 *    table can recompute the whole chain forward. Making that infeasible needs
 *    an external anchor (periodic hash published to a WORM store / another
 *    trust domain), which is more infrastructure this baseline does not have.
 *  - Truncating the tail of the chain is undetectable without an external
 *    high-water mark.
 */

const CHAIN_GENESIS = '0'.repeat(64);

function canonical(entry) {
  return JSON.stringify([
    entry.org_id,
    entry.org_seq,
    entry.actor_kind,
    entry.actor_id ?? null,
    entry.action,
    entry.subject_type,
    entry.subject_id,
    entry.metadata,
    entry.at,
  ]);
}

function digest(prevHash, entry) {
  return crypto.createHash('sha256').update(prevHash).update(canonical(entry)).digest('hex');
}

/**
 * Appends one entry. MUST run inside a transaction that already holds a row
 * lock on orgs(id) — otherwise two concurrent writers read the same tip and
 * produce a forked chain. This serialisation requirement is invisible in the
 * type system and is exactly the kind of thing that survives code review.
 */
export async function appendAudit(tx, { orgId, actorKind, actorId, action, subjectType, subjectId, metadata = {} }) {
  const { rows: tip } = await tx.query(
    'SELECT org_seq, hash FROM audit_log WHERE org_id = $1 ORDER BY org_seq DESC LIMIT 1',
    [orgId]
  );
  const prevHash = tip[0]?.hash ?? CHAIN_GENESIS;
  const orgSeq = (tip[0] ? Number(tip[0].org_seq) : 0) + 1;
  const at = new Date().toISOString();

  const entry = {
    org_id: orgId,
    org_seq: orgSeq,
    actor_kind: actorKind,
    actor_id: actorId ?? null,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    metadata,
    at,
  };
  const hash = digest(prevHash, entry);

  await tx.query(
    `INSERT INTO audit_log
       (org_id, org_seq, actor_kind, actor_id, action, subject_type, subject_id, metadata, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [orgId, orgSeq, actorKind, actorId ?? null, action, subjectType, subjectId,
     JSON.stringify(metadata), at, prevHash, hash]
  );
  return { orgSeq, hash };
}

export async function verifyChain(db, orgId) {
  const { rows } = await db.query(
    `SELECT org_id, org_seq, actor_kind, actor_id, action, subject_type, subject_id,
            metadata, at, prev_hash, hash
       FROM audit_log WHERE org_id = $1 ORDER BY org_seq ASC`,
    [orgId]
  );
  let prevHash = CHAIN_GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Number(r.org_seq) !== i + 1) {
      return { ok: false, brokenAt: i + 1, reason: 'sequence_gap' };
    }
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
