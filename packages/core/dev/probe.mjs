// Environment check: confirms PGlite + pgcrypto are present and that
// schema.sql applies cleanly. Run: npm run dev:probe (from the repository root)
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = await PGlite.create({ extensions: { pgcrypto } });
console.log((await db.query('select version()')).rows[0].version);
await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto');
await db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8'));
const { rows } = await db.query(
  `select table_name from information_schema.tables where table_schema='public' order by 1`,
);
console.log('schema applied:', rows.map((r) => r.table_name).join(', '));
