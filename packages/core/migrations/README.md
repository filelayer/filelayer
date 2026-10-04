# Migrations

One file per schema change, numbered by its entry in
[`../MIGRATIONS.md`](../MIGRATIONS.md). Each file contains **exactly one
runnable path** and nothing else: no alternatives presented as consecutive
statements, no `<placeholders>`, no audit queries mixed in with the DDL.

That sentence is the whole point of this directory, and it exists because the
prose did not satisfy it. `MIGRATIONS.md` §2 promised "the forward SQL, written
to be pasted into your own migration tool", and on 4 October 2026 that promise
was checked against the thirteen fenced SQL blocks in the file:

* **Entry 3 pasted verbatim does both things.** The block carries
  `2a. Revoke them (recommended)` **and** `2b. ...keep them open and drop the
  inert hash` as consecutive `UPDATE`s. A runner executes both: it revokes every
  password-bearing grant and then strips the hashes it just revoked.
* **Entry 8 pasted verbatim creates the same index twice.** Three of its four
  blocks are three alternative formulations of the same change — the plain one,
  the `CONCURRENTLY` one, and the `NOT VALID` + `VALIDATE` one — not three steps.
* **Entry 6's second block has a `<your_app_role>` placeholder** and is a
  `REVOKE` recommendation rather than part of the migration.
* **Entries 1, 4 and 5 are not complete scripts.** Entry 1 ends by telling you
  to copy three blocks "verbatim from `schema.sql`" at a version the tree no
  longer contains. Entry 4's only block is a detection `SELECT`; it has no
  forward DDL at all. Entry 5's second block is an `EXPLAIN`.
* **Entries 5 and 8 use `CREATE INDEX CONCURRENTLY`**, which cannot run inside a
  transaction — and a migration runner that wraps each file in one, which most
  do, fails on it.

None of that was false in prose. Each block is labelled where it sits. But the
instruction "paste the forward SQL into your own tool" plus thirteen fenced
blocks is a trap, and nobody had walked into it only because nobody has ever
run these migrations: there are no installs.

## What each file guarantees

1. **One path.** Where the original entry offered a choice, the file takes the
   recommended one and the alternative is a comment you have to act on
   deliberately. `requiresDecision` in the manifest says which files those are.
2. **A precondition guard, first.** Every file refuses, with a named error and a
   message that says what to do, if the database is not in the state it expects
   — already applied, or missing an earlier change. Running them out of order is
   the likeliest operator mistake and it is the one this makes safe.
3. **It has been executed.** `npm run check:migrations` creates a real
   PostgreSQL at the *previous* release's `schema.sql`, applies the file, and
   compares the resulting structure — columns, constraints, indexes, enum label
   order, triggers, rules, function signatures — against the *next* release's
   `schema.sql` applied fresh. A file that does not reproduce the next schema
   fails the build. Real PostgreSQL rather than the WASM build the rest of the
   suite uses, because `CONCURRENTLY` needs more than one backend and migrations
   are a thing you run against a real server.

## What they do not do

There is no runner here and there is not going to be one, which is the position
`MIGRATIONS.md` §2 has always taken: your application owns a migration runner
and ours has no business competing with it. `manifest.json` is machine-readable
so your runner can enumerate these instead of a human transcribing them, and
`schemaStatus(db)` tells you where a database is. Neither applies anything.

Entries 1 and 2 have no file. They predate the oldest tag in the repository
(`v0.4.4`), so there is no "before" schema to apply them to and therefore no way
to verify them. They are a record of what happened, and they say so.
