# How do I erase a user when my audit log is append-only?

A user asks you to delete their data. You delete their rows, you delete their
files from the bucket, and then you reach the audit log, which records every
file they ever opened and which you built to be impossible to change.

The advice you will find is about rows: encrypt each subject's fields under a
per-subject key and destroy the key, or blank the personal columns and leave
the hashes alone. Both are reasonable and neither is about **files**, which is
the harder case, because the bytes live outside the database and the thing you
have to reconcile is a log of access to them.

Everything below is reproduced by
[`erasing-a-user-with-an-append-only-audit-log.proof.mjs`](erasing-a-user-with-an-append-only-audit-log.proof.mjs),
which starts a real PostgreSQL. Every output block below is copied from a run
of it, and every claim with a number attached is asserted there. Three claims
are NOT: that a rule does not stop `TRUNCATE`, what sealing costs, and the
concurrent-append defect, which belongs to
[another page](tamper-evident-file-audit.md) and is proved there.

## The short answer

1. Delete the rows. Ordinary.
2. Delete the objects, and reconcile what the database thinks exists with what
   the bucket holds — that is
   [a different page](deleting-files-and-orphaned-objects.md), and it is where
   most erasure scripts actually fail.
3. **Remove their audit events and attest every hole, in one transaction.**
   One person's events are scattered, so removing them makes several holes,
   and a checkpoint attesting one says nothing about the others. The unit is a
   contiguous run.

---

## The trap, and the mechanism is not the one you would guess

Append-only is usually written as a rule, because a rule is two lines:

```sql
CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING;
CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING;
```

The audit table references the tenant with `ON DELETE CASCADE`, which is the
ordinary choice and is what makes this happen — with the default `NO ACTION`
you get a plain foreign-key violation and the rule never enters the story.
Then the tenant has to go, and the tenant has an audit history:

```
DELETE FROM org WHERE id = $1;

ERROR: referential integrity query on "org" from constraint
       "audit_event_org_id_fkey" on "audit_event" gave unexpected result
HINT:  This is most likely due to a rule having rewritten the query.
```

**Read the HINT.** Most quotes of this error stop at the ERROR line and then
make something mysterious out of it. PostgreSQL tells you the cause in the next
line, in English.

And the cause is **not** "the rows survived, so the foreign key is still
violated". That explanation is wrong, and one word falsifies it. Add a
condition to the same rule — one that is always true, so a direct `DELETE` on
`audit_event` behaves identically:

```sql
CREATE RULE audit_no_delete AS ON DELETE TO audit_event WHERE true DO INSTEAD NOTHING;
```

```
DELETE FROM org                        SUCCEEDED
the org row is gone                    true
audit rows left pointing at it         7
```

Same rule, rows still survive, foreign key still violated — and no error at
all. The parent is gone and the audit trail dangles.

What the referential integrity trigger checks is the **result code** of the
statement it ran internally — `ri_PerformCheck` in `ri_triggers.c` compares the
SPI result against the one it expected, and raises this error with this HINT
when they differ. An unconditional `DO INSTEAD NOTHING`
leaves no statement to run, so the code comes back wrong and the trigger
raises. A conditional one leaves a statement that runs and affects no rows,
which looks fine. The guard is detecting **the rewrite**, not the violation.

### A trigger is not the same, and is worse

PostgreSQL's own manual steers you towards triggers for per-row work. A
`BEFORE DELETE ... RETURN NULL` trigger produces:

```
DELETE FROM org                        SUCCEEDED
audit rows left pointing at it         7
```

No error, no refusal, and a dangling trail. If you take one design decision
from this page: **whatever you use to make the log append-only, test deleting a
parent row before you need to.** The loud failure is the lucky one.

### The rule is also silent about what it suppressed

```
DELETE ... WHERE actor_id = 'erika'    reported 0 row(s)
rows actually removed                  0
```

No exception. An erasure script written the obvious way — run the statements,
catch exceptions, report success — **reports success and erases nothing.** Of
the outcomes on this page that is the worst: you have told a person and a
regulator that their data is gone, and it is not.

An erasure job must verify by counting, not by the absence of an exception.

---

## Why deleting anyway does not work

Drop the rule and delete her events. Every row carries the hash of the one
before it, so a removal from the middle leaves a successor whose `prev_hash`
points at something no longer there.

```
replay after an unattested removal     valid=false brokenAt=2
```

The verifier working exactly as designed, and useless to you: the log now says
somebody tampered with it, and the somebody was your lawful erasure job. There
is nothing in the data that distinguishes the two, which is the whole point of
building it this way and is now your problem.

## The fix: one checkpoint per contiguous run

Her events are interleaved with other people's — `e, o, e, e, o, e, o` — so
removing them makes **three** holes, not four, because two of hers were
adjacent. Find the runs with gaps and islands over the chain's own ordering,
and anchor a checkpoint on the **last** event of each:

```sql
WITH chain AS (
  SELECT id, hash, actor_id, row_number() OVER (ORDER BY id) AS chain_rn
    FROM audit_event WHERE org_id = $1
), doomed AS (
  SELECT id, hash, chain_rn - row_number() OVER (ORDER BY id) AS run
    FROM chain WHERE actor_id = $2
)
SELECT (array_agg(id   ORDER BY id DESC))[1] AS last_id,
       (array_agg(hash ORDER BY id DESC))[1] AS last_hash,
       count(*)                              AS n
  FROM doomed GROUP BY run ORDER BY min(id);
```

**This query has a precondition, and it is the one thing on this page you must
check against your own schema: `prev_hash` must link each event to the previous
event OF THE SAME TENANT.** The `chain` CTE filters by `org_id`, so if your
chain is table-wide instead, these runs are computed over the wrong sequence
and you will write too few checkpoints — leaving unattested holes, during an
erasure, which is the exact failure this page is about.

Given that, contiguity is over the **chain**, not over `id`: ids come from one
sequence shared by every tenant, so one tenant's events are non-contiguous in
id terms even where they are adjacent in its chain. Measured, with two tenants
interleaved:

```
runs found by chain position           3
runs found by raw id adjacency         4
```

One extra checkpoint here, and every extra one is a row nothing will ever
consume. The gap grows with how much of your traffic belongs to other tenants.
**With a single tenant the two numbers are equal**, which is why a one-tenant
fixture cannot test this at all.

The checkpoint goes on the last event of a run because that is the hash the
first surviving event after the hole still carries in its `prev_hash`.

```
events removed                         4
contiguous runs, so checkpoints        3
replay                                 valid=true checked=3
holes, and whether they are accounted  attestedGaps=3
everyone else's events                 3, untouched
```

**`attestedGaps` is not zero here, and must not be.** A trimmed chain is not a
clean chain: it is a chain whose history is shorter than what happened, by a known
amount, for a recorded reason. Anything that reports it as simply valid has
discarded the one fact a reader of that log needs.

### A run at the end of the chain is the exception

A hole needs a surviving event after it. If the person's most recent events
are also the chain's most recent events, removing them leaves no successor, so
no `prev_hash` points at the missing hash and **that run's checkpoint is never
consumed**: `attestedGaps` comes back lower than the number of checkpoints you
wrote.

Nothing is wrong, and nothing is detected either. That is the truncation hole
in its honest form — replay walks forward and nothing inside the chain records
where it was supposed to end. The checkpoint is still worth writing, because it
is the only record that the removal happened, but it is a record for a human
rather than evidence the verifier can use. Seal the head if you want that case
covered, and read the last bullet of the previous section for what sealing
then costs you.

Write the request into the `note`. Six months later the question will not be
"was this tampered with" but "why is there a hole here", and the answer should
be in the row rather than in somebody's memory.

---

## Why you cannot just redact the columns instead

The standard advice is to blank the personal fields and keep the stored hash.
Whether that works depends entirely on what your digest covers. Ours covers
the identity:

```
[prevHash, orgId, occurredAt, action, decision, reason,
 actorId, fileId, grantId, ip, userAgent, context]
```

So:

```
blank the personal column, keep hashes  valid=false problem=edited
```

That is not a defect. It is the property you asked for, seen from the other
side: **a log you can redact per subject is a log whose identity fields were
never protected.** If `actor_id` is outside your digest, then an attacker can
reassign an event to somebody else and replay will not notice — which is a
worse problem than the one redaction solves.

Pick deliberately. Identity inside the digest means detection and removal.
Identity outside means redaction and a weaker guarantee. There is no
arrangement that gives both.

---

## What a checkpoint does not prove

Three things, because a page that stops at the happy path is an advert.

**It is forgeable.** The value a checkpoint must carry is sitting in plaintext
in the `prev_hash` of the first surviving row after the hole:

```
a checkpoint forged from the next row  valid=true
it claims removed_count                1, and 2 were removed
```

Anyone who can INSERT into `audit_checkpoint` can excuse a hole they just made.
So that table needs the same append-only protection as `audit_event`, and the
schema that protects only one of them is the common mistake.

**`removed_count` is not verified.** Replay never reads it. A checkpoint
claiming one removal forgives a hole of a hundred thousand. It records
**intent**, which is worth having, and says nothing about scale.

**And the removed events are not unrecoverable.** Their hashes survive in the
next event's `prev_hash` and in the checkpoint. With a small guess space, a
motivated party can confirm what an event was. If that matters to you, the
answer is an HMAC under a key you can destroy, not a bare SHA-256 — and that
is crypto-shredding, with its own unsettled legal status.

### Three more things an implementer hits

- **Serialize the append.** Read-the-last-hash-then-insert forks under
  concurrent writers: two rows share a `prev_hash` and replay reports
  tampering. [That page](tamper-evident-file-audit.md) covers the single
  statement that fixes it.
- **A rule does not stop `TRUNCATE`.** Rules fire on SELECT, INSERT, UPDATE and
  DELETE. Nothing in that list is `TRUNCATE`, and the table owner can drop the
  rule anyway.
- **Truncation of the most recent events is still invisible to replay**, and an
  honest erasure of the latest events looks exactly like it. If you seal the
  head, a seal that a trim checkpoint reaches past has to be forgiven, which
  weakens the seal by precisely the amount an attacker who can also write
  checkpoints can exploit.

---

## Does this count as erasure?

We do not know, and neither does anyone who tells you confidently that it does.
Whether removing events and keeping a hash of what they were satisfies a
request is a question for a data protection lawyer in your jurisdiction. Note
also Article 17(3), which is the clause most people facing this end up relying
on, and which is about grounds for *not* erasing.

What this page gives you is the engineering property: the removal is scoped to
one person, every hole it makes is recorded, and the log does not read as
compromised afterwards. Whether that is the right amount of removal is not a
decision a library makes for you.

---

## If you would rather not build it

[Filelayer](https://filelayer.dev) ships this shape.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
await fl.orgs.create('acme', { owner: 'alice' });
await fl.orgs.setRole('acme', 'erika', 'member', { as: 'alice' });
const { id } = await fl.files.put(new TextEncoder().encode('x'), {
  org: 'acme', owner: 'alice', visibility: 'org',
});
for (const who of ['erika', 'alice', 'erika', 'erika', 'alice']) await fl.files.get(id, { as: who });
-->

```ts
const org = (await fl.ids.orgId('acme'))!;
const erika = await fl.ids.ensureActor('erika');

const { removed, checkpoints } = await fl.eraseActorFromAuditChain(org, erika, {
  note: 'erasure request, ticket 4471',
});

// One checkpoint per contiguous run. STRICTLY fewer than events removed,
// because two of hers were adjacent -- `<=` would also pass for one per event.
assert.ok(removed > 0);
assert.ok(checkpoints.length < removed);
assert.ok(checkpoints.every((c) => c.note === 'erasure request, ticket 4471'));

// The chain still verifies, and still says its history is shorter.
const v = await fl.verifyAuditChain({ actorId: await fl.ids.ensureActor('alice') }, org);
assert.equal(v.valid, true);

// Every INTERIOR hole is attested. This fixture has no run at the end of the
// chain; if yours does, that run's checkpoint is written and never consumed,
// so `attestedGaps` comes back lower. See "a run at the end of the chain".
assert.ok(v.attestedGaps > 0 && v.attestedGaps <= checkpoints.length);
```

That block is executed by `npm run check:docs` on every commit.

It erases nothing else: files, grants, memberships and your own tables are
yours. And it is not itself audited, deliberately — the event recording it
would name the person you were asked to remove, which is why the `note` is
required and a blank one is refused.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [How do I prove who accessed a file?](tamper-evident-file-audit.md) — the
  chain itself, the concurrent-append defect, and the truncation hole in full.
- [How do I delete a file without leaving orphaned objects in S3?](deleting-files-and-orphaned-objects.md) —
  step 2 above, which is where most erasure scripts fail.
- [What background jobs does a file feature need, and did they run?](background-jobs-for-user-files.md) —
  retention is one of them, and nothing schedules it for you.

## Sources

- [GDPR erase is inconsistent with the immutable audit log](https://github.com/ApexChainx/ApexChainx-Backend/issues/512) —
  the tension, stated as an open issue.
- [Implement a GDPR-style data-subject erasure workflow](https://github.com/Ledger-Lenz/Ledgerlens-core/issues/349) —
  the same question in another project, answered with crypto-shredding.
- [pgsql-bugs, October 2007: rules and referential integrity](https://www.postgresql.org/message-id/592647410710250955k98ebf33u23d90dc24d0f2ad1%40mail.gmail.com) —
  the report that documents the `WHERE true` difference above.
- [PostgreSQL: Rules on INSERT, UPDATE, and DELETE](https://www.postgresql.org/docs/current/rules-update.html) —
  including the recommendation to prefer a trigger for per-row work.
