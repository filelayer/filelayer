/**
 * A STRUCTURAL FINGERPRINT OF A LIVE SCHEMA.
 *
 * Not a text diff of schema.sql: two files that differ in comments, whitespace
 * or statement order can describe the same database, and a migration's job is
 * to produce the same DATABASE, not the same file. So this asks Postgres what
 * it ended up with and sorts the answer.
 *
 * Everything a security property rests on is in here: columns, every constraint
 * definition, every index definition, enum labels IN ORDER (the grant subject
 * type is an enum and `ALTER TYPE ... ADD VALUE ... AFTER` makes order part of
 * the migration), triggers, rules, and function signatures.
 *
 * Function BODIES are deliberately out. `pg_get_functiondef` differs on
 * whitespace that `CREATE OR REPLACE` normalises differently between versions,
 * and a body difference that matters shows up as a behaviour difference in the
 * 531-test suite, which is a better instrument for it than string equality.
 */
const Q = {
  columns: `
    SELECT table_name || '.' || column_name || ' ' || data_type
           || CASE WHEN character_maximum_length IS NOT NULL
                   THEN '(' || character_maximum_length || ')' ELSE '' END
           || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
           || COALESCE(' DEFAULT ' || column_default, '') AS d
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY d`,
  constraints: `
    SELECT c.conrelid::regclass || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS d
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'
     ORDER BY d`,
  indexes: `SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'public' ORDER BY d`,
  enums: `
    SELECT t.typname || ' = ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS d
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     GROUP BY t.typname
     ORDER BY d`,
  triggers: `
    SELECT c.relname || ' ' || t.tgname || ' ' || pg_get_triggerdef(t.oid) AS d
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY d`,
  rules: `
    SELECT c.relname || ' ' || r.rulename || ' ' || pg_get_ruledef(r.oid) AS d
      FROM pg_rewrite r
      JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND r.rulename <> '_RETURN'
     ORDER BY d`,
  functions: `
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> '
           || pg_get_function_result(p.oid) AS d
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY d`,
};

/** `exec`-capable handle in, sorted object out. */
export async function dumpSchema(pg) {
  const out = {};
  for (const [name, sql] of Object.entries(Q)) {
    const r = await pg.query(sql);
    out[name] = (r.rows ?? []).map((row) => String(row.d).replace(/\s+/g, ' ').trim()).sort();
  }
  return out;
}

/** Human-readable difference, or null when the two are structurally equal. */
export function diffSchema(a, b, labelA = 'a', labelB = 'b') {
  const lines = [];
  for (const section of Object.keys(Q)) {
    const setA = new Set(a[section] ?? []);
    const setB = new Set(b[section] ?? []);
    const onlyA = [...setA].filter((x) => !setB.has(x));
    const onlyB = [...setB].filter((x) => !setA.has(x));
    for (const x of onlyA) lines.push(`  ${section}: only in ${labelA}:  ${x}`);
    for (const x of onlyB) lines.push(`  ${section}: only in ${labelB}:  ${x}`);
  }
  return lines.length ? lines.join('\n') : null;
}
