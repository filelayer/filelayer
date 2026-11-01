/**
 * THE LOCAL USAGE REPORT: what a deployment did in one week, as a file the
 * adopter reads and may choose to share. Nothing here sends anything anywhere.
 *
 * -----------------------------------------------------------------------------
 * WHY IT EXISTS
 * -----------------------------------------------------------------------------
 *
 * Filelayer is a library inside somebody else's application. Its usage lives in
 * their database and nothing leaves it, which is the product's privacy promise
 * and also means nobody, including us, can tell whether a deployment exists.
 * This builds an aggregate summary from rows the library already writes, so an
 * adopter who wants to say "this runs in production" can show it, and decide
 * for themselves what to send. A deployment that sends nothing is UNKNOWN to
 * us, never zero.
 *
 * -----------------------------------------------------------------------------
 * THE THREE RULES THIS FILE IS HELD TO
 * -----------------------------------------------------------------------------
 *
 * 1. CLOSED SCHEMA. The report's whole shape is `usage-report.schema.json`.
 *    `buildUsageReport()` validates its own output against it before returning
 *    and throws on any difference, so a field added here and not there cannot
 *    be returned. `tools/check-usage-report.mjs` checks the schema itself is
 *    closed at every level.
 * 2. NO NETWORK. This module imports nothing that can open a socket; the only
 *    I/O is the database it is handed and the schema file it ships with. The
 *    gate checks the import graph, and the suite runs the builder with every
 *    network entry point replaced by one that throws.
 * 3. MISSING IS NULL, NEVER ZERO. A count that cannot be read is `null` and the
 *    report says why in `notes`, with a fixed code.
 *
 * Aggregation happens in SQL. No query reads an org, actor, file or grant id,
 * an IP, a user agent, an event context or any name into this process.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Path of the shipped schema: one level above src/ and dist/ alike. */
export const USAGE_REPORT_SCHEMA_PATH = join(HERE, '..', 'usage-report.schema.json');

export type UsageReportNote =
  | 'errors_not_measured'
  | 'unshare_not_recorded'
  | 'audit_trimmed'
  | 'no_files'
  | 'no_successful_read'
  | 'lib_version_unknown';

export type ScaleBucket = '0' | '1-10' | '11-1k' | '1k-100k' | '>100k';

export type StorageKind = 'memory' | 'fs' | 's3' | 'r2' | 'other';

export interface UsageReport {
  format: 1;
  install_id: string;
  week: string;
  lib_version: string | null;
  node_major: number;
  storage_kind: StorageKind[] | null;
  schema_version: number;
  days_active: number | null;
  ops: {
    upload: number | null;
    read_allowed: number | null;
    read_denied: number | null;
    share_create: number | null;
    share_revoke: number | null;
    unshare: number | null;
    direct_upload: number | null;
    job_run: number | null;
  };
  errors: null;
  first_success_day: number | null;
  scale_bucket: { files: ScaleBucket; orgs: ScaleBucket };
  notes: UsageReportNote[];
}

// -----------------------------------------------------------------------------
// The validator. Only the JSON Schema keywords the schema file uses, and an
// unknown keyword in the schema is an error rather than something skipped: a
// validator that ignores what it does not understand reports "valid" for
// exactly the constraints it never checked.
// -----------------------------------------------------------------------------

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  '$schema', '$id', '$comment', 'title', 'type', 'const', 'enum', 'pattern',
  'minimum', 'maximum', 'properties', 'required', 'additionalProperties',
  'items', 'uniqueItems', 'maxItems',
]);

let cachedSchema: Schema | null = null;

export function usageReportSchema(): Schema {
  if (cachedSchema === null) {
    cachedSchema = JSON.parse(readFileSync(USAGE_REPORT_SCHEMA_PATH, 'utf8')) as Schema;
  }
  return cachedSchema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Problems with `value` against `schema`, as `path: message` strings. Empty means valid. */
export function validateAgainst(schema: Schema, value: unknown, path = '$'): string[] {
  const out: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) return [`${path}: schema uses "${k}", which this validator does not implement`];
  }
  const t = typeOf(value);
  if ('const' in schema && value !== schema.const) {
    out.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    return out;
  }
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const ok = allowed.includes(t) || (t === 'integer' && allowed.includes('number'));
    if (!ok) {
      out.push(`${path}: is ${t}, must be ${allowed.join(' or ')}`);
      return out;
    }
  }
  if (t === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value as string)) {
    out.push(`${path}: does not match ${schema.pattern}`);
  }
  if (t === 'integer' || t === 'number') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (t === 'array') {
    const arr = value as unknown[];
    if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(arr.map((x) => JSON.stringify(x))).size !== arr.length) out.push(`${path}: items repeat`);
    if (schema.items !== undefined) {
      arr.forEach((x, i) => out.push(...validateAgainst(schema.items as Schema, x, `${path}[${i}]`)));
    }
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) {
      if (!(r in obj)) out.push(`${path}: missing ${r}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) out.push(...validateAgainst(props[k]!, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unknown field ${k}`);
    }
  }
  return out;
}

/** Problems with a report against the shipped schema. Empty means valid. */
export function validateUsageReport(value: unknown): string[] {
  return validateAgainst(usageReportSchema(), value);
}

// -----------------------------------------------------------------------------
// ISO weeks, UTC.
// -----------------------------------------------------------------------------

/** The ISO week (`YYYY-Www`, UTC) containing `d`. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of an ISO week, and the Monday after it. */
export function isoWeekRange(week: string): { start: Date; end: Date } {
  const m = /^([0-9]{4})-W([0-9]{2})$/.exec(week);
  if (!m) throw new Error(`not an ISO week: ${JSON.stringify(week)} (expected YYYY-Www)`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000);
  const start = new Date(monday1.getTime() + (n - 1) * 7 * 86_400_000);
  if (n < 1 || isoWeekOf(start) !== week) throw new Error(`no such ISO week: ${week}`);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

// -----------------------------------------------------------------------------
// The builder.
// -----------------------------------------------------------------------------

export interface BuildUsageReportOptions {
  /** ISO week, `YYYY-Www`. Default: the last complete ISO week before `now`. */
  week?: string;
  /** For tests. Default: the current time. */
  now?: Date;
}

const PKG_PATH = join(HERE, '..', 'package.json');

const STORAGE_KINDS: readonly StorageKind[] = ['memory', 'fs', 's3', 'r2', 'other'];
const NOTE_ORDER: readonly UsageReportNote[] = [
  'errors_not_measured',
  'unshare_not_recorded',
  'audit_trimmed',
  'no_files',
  'no_successful_read',
  'lib_version_unknown',
];

/**
 * Audit actions counted, and the report field each feeds. One table, here and
 * in the documentation, so the mapping is a fact somebody can check.
 *
 * `file.create` is every file created, direct uploads included (their
 * reservation creates the row); `file.upload_complete` counts only the direct
 * uploads that finished. A redirect delivery writes `file.read` for the
 * decision and `file.deliver` for the redirect, so reads are counted on
 * `file.read` alone, once each. A file operation by an identity the deployment
 * has never seen is refused before any file is looked up and recorded as
 * `file.access`; those refusals are counted in `read_denied` too, because most
 * of them are reads and the audit row cannot say which ones are not. `unshare()` writes one `grant.revoke` per grant
 * it removes and nothing of its own, so it cannot be counted apart from
 * `share_revoke` and is null.
 */
const AUDIT_OPS: readonly { action: string; decision: 'allow' | 'deny'; field: keyof UsageReport['ops'] }[] = [
  { action: 'file.create', decision: 'allow', field: 'upload' },
  { action: 'file.read', decision: 'allow', field: 'read_allowed' },
  { action: 'file.read', decision: 'deny', field: 'read_denied' },
  { action: 'file.access', decision: 'deny', field: 'read_denied' },
  { action: 'grant.create', decision: 'allow', field: 'share_create' },
  { action: 'grant.revoke', decision: 'allow', field: 'share_revoke' },
  { action: 'file.upload_complete', decision: 'allow', field: 'direct_upload' },
];

function bucket(n: number): ScaleBucket {
  if (n <= 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 1000) return '11-1k';
  if (n <= 100_000) return '1k-100k';
  return '>100k';
}

function kindOf(provider: string): StorageKind {
  return (STORAGE_KINDS as readonly string[]).includes(provider) && provider !== 'other'
    ? (provider as StorageKind)
    : 'other';
}

/**
 * Build the report for one ISO week. Reads only, except that the first call
 * writes the deployment's random `install_id` into `filelayer_install`.
 * Validates its own result against `usage-report.schema.json` and throws if it
 * does not match.
 */
export async function buildUsageReport(
  db: Queryable,
  opts: BuildUsageReportOptions = {},
): Promise<UsageReport> {
  const now = opts.now ?? new Date();
  const week = opts.week ?? isoWeekOf(new Date(now.getTime() - 7 * 86_400_000));
  const { start, end } = isoWeekRange(week);
  if (start.getTime() > now.getTime()) throw new Error(`week ${week} has not started yet`);
  const notes = new Set<UsageReportNote>(['errors_not_measured', 'unshare_not_recorded']);
  const count = (v: unknown): number => Number(v ?? 0);

  // The install id: written once, read every time.
  await db.query(`INSERT INTO filelayer_install (id) VALUES ($1) ON CONFLICT DO NOTHING`, [randomUUID()]);
  const { rows: idRows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM filelayer_install LIMIT 1`);
  const installId = idRows[0]?.id;
  if (!installId) throw new Error('filelayer_install has no row after writing one');

  const { rows: verRows } = await db.query<{ v: number | string; created: Date | string }>(
    `SELECT MAX(version) AS v, MIN(applied_at) AS created FROM filelayer_schema_version`,
  );
  const schemaVersion = count(verRows[0]?.v);
  const createdAt = verRows[0]?.created ? new Date(verRows[0].created) : null;

  const { rows: kindRows } = await db.query<{ p: string }>(`SELECT DISTINCT storage_provider AS p FROM file`);
  const storageKind = kindRows.length === 0
    ? null
    : STORAGE_KINDS.filter((k) => kindRows.some((r) => kindOf(r.p) === k));
  if (storageKind === null) notes.add('no_files');

  // A trim or an erasure that removed events from this week makes every count
  // read from the audit log an undercount, and an undercount reported as a
  // number is the error this report exists to avoid.
  const { rows: trimRows } = await db.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM audit_checkpoint
      WHERE kind = 'trim' AND removed_from < $2 AND removed_to >= $1`,
    [start.toISOString(), end.toISOString()],
  );
  const trimmed = count(trimRows[0]?.n) > 0;
  if (trimmed) notes.add('audit_trimmed');

  const ops: UsageReport['ops'] = {
    upload: null, read_allowed: null, read_denied: null, share_create: null,
    share_revoke: null, unshare: null, direct_upload: null, job_run: null,
  };
  if (!trimmed) {
    const { rows } = await db.query<{ action: string; decision: string; n: number | string }>(
      `SELECT action, decision, COUNT(*) AS n FROM audit_event
        WHERE occurred_at >= $1 AND occurred_at < $2 AND action = ANY($3::text[])
        GROUP BY action, decision`,
      [start.toISOString(), end.toISOString(), [...new Set(AUDIT_OPS.map((o) => o.action))]],
    );
    for (const o of AUDIT_OPS) {
      const hit = rows.find((r) => r.action === o.action && r.decision === o.decision);
      ops[o.field] = (ops[o.field] ?? 0) + (hit ? count(hit.n) : 0);
    }
  }
  const { rows: jobRows } = await db.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM job_run WHERE finished_at >= $1 AND finished_at < $2`,
    [start.toISOString(), end.toISOString()],
  );
  ops.job_run = count(jobRows[0]?.n);

  let daysActive: number | null = null;
  if (!trimmed) {
    const { rows } = await db.query<{ n: number | string }>(
      `SELECT COUNT(DISTINCT d) AS n FROM (
         SELECT day AS d FROM usage_daily WHERE day >= $1::date AND day < $2::date
         UNION
         SELECT (occurred_at AT TIME ZONE 'UTC')::date AS d FROM audit_event
          WHERE occurred_at >= $1 AND occurred_at < $2
       ) days`,
      [start.toISOString(), end.toISOString()],
    );
    daysActive = count(rows[0]?.n);
  }

  let firstSuccessDay: number | null = null;
  const { rows: firstRows } = await db.query<{ t: Date | string | null }>(
    `SELECT MIN(occurred_at) AS t FROM audit_event WHERE action = 'file.read' AND decision = 'allow'`,
  );
  const first = firstRows[0]?.t ? new Date(firstRows[0].t) : null;
  if (first && createdAt) {
    firstSuccessDay = Math.max(0, Math.floor((first.getTime() - createdAt.getTime()) / 86_400_000));
  } else {
    const { rows: anyTrim } = await db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM audit_checkpoint WHERE kind = 'trim'`,
    );
    notes.add(count(anyTrim[0]?.n) > 0 ? 'audit_trimmed' : 'no_successful_read');
  }

  const { rows: scaleRows } = await db.query<{ files: number | string; orgs: number | string }>(
    `SELECT (SELECT COUNT(*) FROM file) AS files, (SELECT COUNT(*) FROM org) AS orgs`,
  );

  // The package's own version, from its package.json. Null rather than a guess
  // when that file has no version: the documented way to run this suite from
  // an install replaces package.json with a stub, and an adopter's tooling can
  // too.
  let libVersion: string | null = null;
  try {
    const v = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version?: unknown }).version;
    if (typeof v === 'string' && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.]{1,32})?$/.test(v)) libVersion = v;
  } catch {
    libVersion = null;
  }
  if (libVersion === null) notes.add('lib_version_unknown');

  const report: UsageReport = {
    format: 1,
    install_id: installId,
    week,
    lib_version: libVersion,
    node_major: Number(process.versions.node.split('.')[0]),
    storage_kind: storageKind,
    schema_version: schemaVersion,
    days_active: daysActive,
    ops,
    errors: null,
    first_success_day: firstSuccessDay,
    scale_bucket: { files: bucket(count(scaleRows[0]?.files)), orgs: bucket(count(scaleRows[0]?.orgs)) },
    notes: NOTE_ORDER.filter((n) => notes.has(n)),
  };
  const problems = validateUsageReport(report);
  if (problems.length > 0) {
    throw new Error(`buildUsageReport produced a report its own schema refuses:\n  ${problems.join('\n  ')}`);
  }
  return report;
}

