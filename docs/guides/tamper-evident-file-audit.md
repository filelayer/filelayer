# How do I prove who accessed a file?

An `access_log` table answers a different question from the one you will be
asked. It answers *what did we record*. A compliance auditor, a customer's
security questionnaire, or a regulator asks *could that record have been
changed* — and a table anybody with database access can `UPDATE` has no answer.

This guide is about closing that gap, what closing it actually buys, and the
three things it does not buy. It is written to be useful whether or not you use
Filelayer: the schema, the function and the verification below are yours to
copy, and the script beside this page reproduces every claim against a real
PostgreSQL in about thirty seconds — including the one claim that is a
limitation rather than a feature.

---

## The short answer

Give every event a hash over its own contents **and the previous event's hash**.
Then the log is a linked list in which changing any one row invalidates every
row after it, so an edit cannot be made quietly — only visibly.

That gets you three of the four things that can be done to a log:

| What was done | Detected by replay | How |
|---|---|---|
| An event was edited | **yes** | its recomputed hash no longer matches |
| An event was removed from the middle | **yes** | its successor's `prev_hash` points at nothing |
| The first event was removed | **yes** | the new first row has a non-null `prev_hash` |
| The most recent n events were removed | **no** | what remains is a perfectly consistent chain |

That last row is the honest part of this guide, and most of the design work is
about it. It is structural, not an oversight waiting to be fixed: replay walks
forward, and nothing inside a table can record where that table was supposed to
end. An anchor kept in the same database is editable by exactly the person you
are defending against.

---

## The table

```sql
CREATE TABLE audit_event (
    id          bigserial PRIMARY KEY,
    org_id      uuid,                  -- NULL = the system chain, see below
    occurred_at timestamptz NOT NULL DEFAULT now(),
    action      text NOT NULL,         -- file.read, grant.revoke, member.add, ...
    decision    text NOT NULL CHECK (decision IN ('allow', 'deny')),
    reason      text,                  -- why denied; null when allowed
    actor_id    uuid,
    file_id     uuid,
    grant_id    uuid,
    ip          inet,
    user_agent  text,
    context     jsonb NOT NULL DEFAULT '{}'::jsonb,

    prev_hash   text,
    hash        text NOT NULL
);
```

Three decisions in there are worth defending, because each of them was a defect
first.

### Record denials, not just successes

A log of successful reads tells you what happened. A log that also records
refusals tells you what somebody *tried*, which is the half an incident is
actually about. `decision` and `reason` exist so that a sweep of file ids leaves
three thousand rows rather than silence.

### No foreign keys on `actor_id`, `file_id`, `org_id`

This looks like laxity and is the opposite. Two reasons, both learned the hard
way.

**The log must be able to record an identifier that does not exist**, because
recording probes at identifiers that do not exist is its job. With
`actor_id REFERENCES actor(id)`, a caller presenting a well-formed but
unregistered id could not be audited at all: the INSERT raised, the exception
propagated out of the authorization call, the denial was never recorded, and the
caller got a 500 where a registered-but-unauthorized caller got a 404. The error
surface became an actor-existence oracle, and an id sweep left no trace — which
is precisely the thing the table exists to catch.

**And `ON DELETE SET NULL` erases attribution.** An audit log that forgets who
did something is not an audit log. Deleting a user must not rewrite what they
did.

There is a sharper version of this with `ON DELETE CASCADE` on `org_id`, and it
is worth knowing before you meet it. Combine a cascade with the append-only rule
below and the cascade is itself a DELETE, the rule rewrites it to nothing, and
PostgreSQL finds that its own referential-integrity check returned something
impossible:

```
referential integrity query on "org" from constraint
"audit_event_org_id_fkey" on "audit_event" gave unexpected result
```

So a tenant that had ever been audited — which is every tenant, because creating
one is an audited action — **could not be deleted at all**. Not soft-deleted and
retained: the statement raised. Nobody hits that until the first erasure
request, which is the worst possible moment to meet a database error.

### A nullable `org_id`, which is a security feature

A probe against a file id that does not exist has no tenant to charge it to.
Guessing one leaks existence; dropping the event makes the single most
characteristic reconnaissance pattern against an object store invisible. So such
events go to a **system chain** (`org_id IS NULL`) that is chained and verifiable
like any other and that no tenant-facing API can read.

---

## Appending, and the defect almost every implementation ships

The obvious way to append is two statements: read the last hash, then insert.

```sql
SELECT hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 1;
-- ... compute ...
INSERT INTO audit_event (...) VALUES (...);
```

That is atomic if and only if there is exactly one writer. With two — one per
API process, several per box — both read the same `prev_hash` and both insert.
**The chain forks.** Verification then reports a `prev_hash` mismatch at the
second of the two, so a perfectly honest log looks tampered with, and, worse, a
genuinely tampered log is no longer distinguishable from routine concurrency.

Tamper evidence that cries wolf is not tamper evidence.

It is tempting to write this down as a single-writer limitation. Any deployment
you would want will have concurrent writers, so the limitation is a defect.

### The fix, and why it has to be one statement

Take an advisory lock on the chain, read the predecessor, hash, and insert —
**all inside one statement**:

```sql
CREATE FUNCTION audit_chain_lock_key(p_org_id uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
    SELECT (hashtext('myapp.audit_chain')::bigint << 32)
         | (hashtext(coalesce(p_org_id::text, '__system__'))::bigint & x'ffffffff'::bigint);
$$;

CREATE FUNCTION audit_append(
    p_org_id uuid, p_action text, p_decision text, p_hash_tail text
) RETURNS TABLE (id bigint, prev_hash text, hash text)
LANGUAGE plpgsql AS $$
DECLARE v_prev text; v_hash text;
BEGIN
    PERFORM pg_advisory_xact_lock(audit_chain_lock_key(p_org_id));

    SELECT a.hash INTO v_prev
      FROM audit_event a
     WHERE a.org_id IS NOT DISTINCT FROM p_org_id
     ORDER BY a.id DESC LIMIT 1;

    v_hash := encode(digest(convert_to(
        '[' || coalesce(to_json(v_prev)::text, 'null') || ',' || p_hash_tail, 'utf8'
    ), 'sha256'), 'hex');

    RETURN QUERY
    INSERT INTO audit_event (org_id, action, decision, prev_hash, hash)
         VALUES (p_org_id, p_action, p_decision, v_prev, v_hash)
      RETURNING audit_event.id, audit_event.prev_hash, audit_event.hash;
END;
$$;
```

**`pg_advisory_xact_lock` is held until the end of the transaction.** In
autocommit — which is how most connection pools issue queries, and what
`pg.Pool.query` does — each statement *is* its own transaction. So taking the
lock in one statement and inserting in the next releases it in between and buys
nothing at all. `SELECT * FROM audit_append(...)` is one statement, so the lock
is held from the moment it is taken until the row is committed, and a second
writer on the same chain waits.

A per-chain key, not a global one, or every tenant serialises behind every other
tenant. And a namespace in the high bits so your lock cannot collide with an
advisory lock taken by something else sharing the database.

Step 4 of the script beside this page stages both: fifty concurrent writers
through the two-statement version, and fifty through this function.

### Two things this shape also buys

**There is no supported path that writes the table without constructing the
chain.** The ordering is not something a caller can get wrong or skip.

**And the hash is still defined in one place.** `prev_hash` is the first element
of the digest input deliberately, so everything after it can be serialized by
the caller and passed in as `p_hash_tail`. This function performs one string
concatenation; it is not a second implementation of your canonical encoding. If
your verifier recomputes the whole digest in application code, then every
verification cross-checks the SQL side against an independent implementation.

The seam is one byte wide, so be explicit about it: SQL supplies `[`, the
predecessor and a comma; `p_hash_tail` supplies everything else **including the
closing bracket**. Off by one there is a chain that never verifies and an
afternoon spent looking for it in the wrong place.

### One ordering rule, or you will deadlock

Taking a chain lock means a transaction now holds it from its first audit write
until commit. Two transactions that take the chain lock and a row lock in
opposite orders will deadlock. Pick one rule and apply it everywhere:

> **The audit chain lock is always taken before any row lock.**

In practice that means auditing the decision *before* the UPDATE it authorizes,
and not reaching for `SELECT ... FOR UPDATE` on the way in out of habit.

---

## Append-only enforcement, and exactly how far it goes

```sql
CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING;
```

Three things to know, and all three matter.

**It is silent.** The statement succeeds and reports zero rows, so a caller who
believes they trimmed the log is not told otherwise. That is a deliberate trade
— failing loudly lets a prober distinguish this table from any other — and it is
worth knowing before you build anything on top of it.

**Rules do not cover `TRUNCATE`.** Rewrite rules are per-DML-statement-type and
`TRUNCATE` is not DML, so `TRUNCATE audit_event` empties the table with both
rules fully in place. A statement-level trigger does fire, so that is what closes
it:

```sql
CREATE FUNCTION audit_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only: TRUNCATE is refused';
END;
$$;

CREATE TRIGGER audit_no_truncate
    BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();
```

**Neither mechanism is a privilege boundary.** Both are owned by the table owner
and can be dropped in one statement. They stop an accident and an ordinary
application bug, which is most of what actually happens to a log. They do not
stop a determined operator, and the chain is what remains when they are gone.

---

## Verifying

Replay the chain forward, recomputing each hash in application code:

- the first row must have `prev_hash IS NULL`
- every other row's `prev_hash` must equal its predecessor's `hash`
- every row's recomputed digest must equal its stored `hash`

Return three things, not a boolean:

- `valid`, and **where** it broke — the id and which of the two checks failed
- `checked`, how many rows were covered
- the **head**: the id and hash of the last event

The head is the half the database cannot provide itself. Pin it somewhere
outside — a daily line in a different system, a customer-held receipt, a
transparency log, a printout. The comparison only means anything in a place the
person who can edit the rows cannot reach. Returning it is how you make that
possible rather than merely advisable.

---

## Retention, which is where most chains quietly die

Your log grows forever and something eventually has to delete the old end. But
**a hash chain cannot be trimmed from the front**: delete the oldest events and
the first survivor's `prev_hash` points at something that is gone, which is
indistinguishable from the tampering the chain exists to detect. The usual
outcome is that retention wins, the chain is left permanently "broken", and
everyone stops reading the verification output.

The missing piece is a row that attests to the deletion:

```sql
CREATE TABLE audit_checkpoint (
    id            bigserial PRIMARY KEY,
    org_id        uuid,
    kind          text NOT NULL CHECK (kind IN ('trim', 'seal')),
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- The chain state this attests to: the last event covered, and its hash.
    -- For a trim, that event is gone and this hash is the only surviving
    -- evidence of where the chain had reached.
    through_id    bigint NOT NULL,
    through_hash  text NOT NULL,

    removed_count integer NOT NULL DEFAULT 0,
    removed_from  bigint,
    removed_to    bigint,
    note          text,

    CONSTRAINT checkpoint_seal_removes_nothing CHECK (
        kind <> 'seal' OR (removed_count = 0 AND removed_from IS NULL AND removed_to IS NULL)
    )
);

CREATE INDEX audit_checkpoint_hash_idx ON audit_checkpoint (through_hash);
```

Verification then has somewhere to look: when replay meets a first survivor
whose `prev_hash` is not NULL, it searches for a checkpoint whose `through_hash`
is that `prev_hash`. If it finds one, it reports an **attested gap** — "n events
were removed on purpose, on this date, and the remaining chain verifies
perfectly" — rather than tampering. If it does not, it is tampering.

Two things this does not claim, and both are better said than discovered:

- **A checkpoint cannot be forged by someone who did not already hold the
  hash.** But whoever removes the events *does* hold it — they had the chain.
  This is bookkeeping, not a cryptographic defence against the operator.
- **It is deliberately not a summary of what was deleted.** An attestation that
  recorded the contents would be a second copy of what it records.

### Seals, which partly close the truncation hole

A `seal` is the same row with nothing removed: it pins where the chain had
reached at a moment in time. That turns the undetectable case — removing the
most recent events — into a **detectable** one: a chain whose head is now behind
a seal it has on record is internally perfect and shorter than it was, and
nothing honest produces that.

Partly, and only partly. Seals live in the same database, so whoever removes
the events can remove the seals in the same transaction. The seal is worth
having because it closes the accident and the ordinary bad actor; the externally
pinned head is what closes the operator. Say both.

---

## What this does not give you

- **It is evidence, not prevention.** A chain tells you the log was altered. It
  does not stop the alteration, and it does not recover what was there.
- **It says nothing about what was not recorded.** If a code path reads a file
  without auditing it, the chain over the remaining events is perfect. Coverage
  is a separate problem with a separate answer: make the audit write
  unskippable by putting it in the same transaction as the decision.
- **Timestamps are your clock's word.** `occurred_at` is committed to by the
  hash, so it cannot be edited afterwards — but nothing stops a wrong clock at
  write time. If the ordering must be provable against the outside world, you
  are asking for a timestamping authority.
- **The chain is not the retention policy.** Legal hold, erasure requests and
  "keep for seven years" are decisions the chain has no opinion about. All it
  does is make the deletions you choose to make attestable.

---

## If you would rather not build it

[Filelayer](https://filelayer.dev) is this shape, packaged: every authorization
decision is appended to a per-tenant hash chain in the same transaction as the
decision itself, denials included, with the single-statement append, the
TRUNCATE trigger, checkpoints and seals in the schema rather than in application
code.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
await fl.orgs.create('acme', { owner: 'alice' });
const { id } = await fl.files.put(new TextEncoder().encode('REPORT'), {
  org: 'acme', owner: 'alice', name: 'report.pdf',
});

await fl.files.get(id, { as: 'alice' });

// A refused read is recorded too, which is the half that matters in an
// incident: this leaves a `deny` event, not silence.
await assert.rejects(() => fl.files.get(id, { as: 'mallory' }));

const chain = await fl.orgs.verifyAudit('acme', { as: 'alice' });
assert.equal(chain.valid, true);
assert.equal(chain.attestedGaps, 0);

// The head is returned so you can pin it OUTSIDE this database, which is the
// only place the comparison detects a truncation.
assert.equal(typeof chain.lastHash, 'string');
```

That block is executed by `npm run check:docs` on every commit.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [How do I revoke a share after the recipient has shared it onwards?](revoking-delegated-access.md) —
  the other half of "who can reach this file", and the lock-ordering rule above
  comes from it.
- [Multi-tenant file access control](multi-tenant-file-access.md) — why the
  tenant boundary belongs in constraints rather than in a `WHERE` clause.

---

## Sources

- [pg_advisory_xact_lock](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS) — PostgreSQL, on transaction-scoped advisory locks
- [The Rule System](https://www.postgresql.org/docs/current/rules.html) — PostgreSQL, on `DO INSTEAD NOTHING` and what rules apply to
- [Event Triggers and `TRUNCATE`](https://www.postgresql.org/docs/current/sql-createtrigger.html) — PostgreSQL, on statement-level `BEFORE TRUNCATE`
- [RFC 6962: Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962) — on append-only logs, published heads, and why the anchor has to live elsewhere
- [How to Time-Stamp a Digital Document](https://link.springer.com/article/10.1007/BF00196791) — Haber and Stornetta, the hash chain this is
