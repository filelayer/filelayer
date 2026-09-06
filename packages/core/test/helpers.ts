import assert from 'node:assert/strict';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer, FilelayerError } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

export interface World {
  db: Queryable;
  storage: MemoryStorage;
  fl: Filelayer;
}

export async function newWorld(): Promise<World> {
  const { db } = await createTestDb();
  const storage = new MemoryStorage();
  const fl = new Filelayer(db, storage, { baseUrl: 'https://files.example.test' });
  return { db, storage, fl };
}

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
export const text = (u: Uint8Array): string => new TextDecoder().decode(u);

/** Assert a call rejects with a FilelayerError of the given HTTP-ish status. */
export async function rejects(
  fn: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<FilelayerError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof FilelayerError, `expected FilelayerError, got ${String(err)}`);
  assert.equal(err.status, status, `expected status ${status}, got ${err.status} (${err.reason})`);
  if (code) assert.equal(err.code, code);
  return err;
}

/** Assert a raw SQL statement is rejected by the database itself. */
export async function dbRejects(
  db: Queryable,
  sql: string,
  params: unknown[],
  match: RegExp,
): Promise<string> {
  let msg: string | null = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.ok(msg !== null, 'expected the database to reject this statement, but it succeeded');
  assert.match(msg, match);
  return msg;
}

/** Pass null to count the system chain (decisions with no tenant). */
export async function countAudit(db: Queryable, orgId: string | null): Promise<number> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM audit_event WHERE org_id IS NOT DISTINCT FROM $1`,
    [orgId],
  );
  return Number(rows[0]!.c);
}
