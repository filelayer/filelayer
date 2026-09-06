// convex/model/audit.ts  --  APPLICATION CODE (counted)
//
// WRITTEN TO SPEC. NOT EXECUTED.
//
// Tamper-EVIDENT audit trail: per-org hash chain,
//     hash_n = sha256(hash_{n-1} || canonical(entry_n))
//
// WHAT CONVEX MAKES EASY HERE, AND IT IS A REAL WIN
// -------------------------------------------------
// Convex mutations are serializable transactions with automatic optimistic
// concurrency control and retry. Two concurrent appends to one org's chain
// cannot interleave: the loser's read set is invalidated and Convex re-runs it.
// The SQL implementation of the same guarantee needs an explicit advisory lock
// per org. This is genuinely nicer and should be counted in Convex's favour.
//
// WHAT IT DOES NOT GIVE YOU
// -------------------------
// There is no `REVOKE UPDATE` in Convex. Every server function has full read
// and write access to every table; the only access boundary is public vs
// `internal`. So `appendAudit` being internal stops *clients* from forging
// entries, but any future mutation in this codebase can `ctx.db.patch` an
// audit row. The chain detects it (see verifyChain) but nothing prevents it.
//
// Docs: https://docs.convex.dev/functions/internal-functions
//       https://docs.convex.dev/database/writing-data
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

const ZERO = "0".repeat(64);

/**
 * The Convex default runtime does not expose Node's `crypto` module. Web
 * Crypto's `crypto.subtle.digest` is available, so the chain hash is computed
 * with it. Cost noted for the record: Postgres has `sha256()` as a builtin, so
 * the SQL baseline needed no equivalent of this file.
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable, key-sorted serialisation. Object key order must not affect the hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

type AuditInput = {
  orgId: Id<"orgs">;
  actorId?: Id<"users">;
  actorKind: Doc<"auditLog">["actorKind"];
  action: Doc<"auditLog">["action"];
  subject: Record<string, unknown>;
};

/** Append one entry. Call from inside the same mutation as the change it records. */
export async function appendAudit(ctx: MutationCtx, e: AuditInput): Promise<number> {
  const last = await ctx.db
    .query("auditLog")
    .withIndex("by_org_seq", (q) => q.eq("orgId", e.orgId))
    .order("desc")
    .first();

  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? ZERO;
  // Mutations are deterministic and replayable; Date.now() inside a Convex
  // mutation is frozen to the transaction's start time, so it is stable across
  // OCC retries. That matters: a wall-clock read that changed on retry would
  // produce a hash that disagrees with the stored timestamp.
  const occurredAt = Date.now();

  const payload = [
    prevHash,
    e.orgId,
    String(seq),
    e.actorId ?? "",
    e.actorKind,
    e.action,
    String(occurredAt),
    canonical(e.subject),
  ].join("|");

  await ctx.db.insert("auditLog", {
    orgId: e.orgId,
    seq,
    actorId: e.actorId,
    actorKind: e.actorKind,
    action: e.action,
    subject: e.subject,
    occurredAt,
    prevHash,
    hash: await sha256Hex(payload),
  });
  return seq;
}

export type ChainResult = { ok: boolean; brokenAt: number | null; checked: number };

export async function verifyChain(
  ctx: { db: MutationCtx["db"] } | { db: any },
  orgId: Id<"orgs">,
): Promise<ChainResult> {
  const rows = await ctx.db
    .query("auditLog")
    .withIndex("by_org_seq", (q: any) => q.eq("orgId", orgId))
    .collect();

  let prev = ZERO;
  let expected = 0;
  let checked = 0;
  for (const r of rows as Doc<"auditLog">[]) {
    expected += 1;
    if (r.seq !== expected) return { ok: false, brokenAt: r.seq, checked };
    const calc = await sha256Hex(
      [
        prev,
        r.orgId,
        String(r.seq),
        r.actorId ?? "",
        r.actorKind,
        r.action,
        String(r.occurredAt),
        canonical(r.subject),
      ].join("|"),
    );
    if (calc !== r.hash || r.prevHash !== prev) {
      return { ok: false, brokenAt: r.seq, checked };
    }
    prev = r.hash;
    checked += 1;
  }
  return { ok: true, brokenAt: null, checked };
}
