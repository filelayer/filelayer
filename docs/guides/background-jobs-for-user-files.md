# What background jobs does a file feature need, and did they run?

A file feature is not finished when upload, download, share and delete work. It
is finished when the things those four leave behind are collected — and the cost
of a file feature in production is almost entirely in that second half.

There are four jobs. Writing them is a morning. The part that goes wrong is
that **every one of them produces an absence as its output**, so a job that has
silently stopped running looks exactly like a job with nothing to do.

This guide is about both halves. It is written to be useful whether or not you
use Filelayer: the schema and the SQL are yours to copy, and the script beside
this page reproduces every claim against a real PostgreSQL in about thirty
seconds — including a data-loss race that only exists with two backends.

---

## The four jobs

| Job | Collects | What it costs you if it never runs |
|---|---|---|
| Abandoned upload reservations | `pending` rows whose upload never completed | rows that are never readable and never collected, plus their bytes |
| Orphaned storage objects | bytes with no row pointing at them | a bucket bill that only goes up |
| Audit retention | an append-only log that grows forever | the table that eventually dominates your database |
| Chain sealing | — | nothing, until you need to prove the log was not truncated |

The second one has its own guide —
[How do I delete a file without leaving orphaned objects in S3?](deleting-files-and-orphaned-objects.md) —
because the sweeper is the most dangerous job you will write and deserves the
space. The third cannot be done naively on a hash-chained log, and
[How do I prove who accessed a file?](tamper-evident-file-audit.md) has the
checkpoint that makes it attestable rather than indistinguishable from an
attack.

This guide takes the first one in full, because it is the one that is usually
written as five lines and a `DELETE`, and then the fourth, and then the thing
all four share.

---

## Abandoned upload reservations

A direct upload is two steps with a gap: you reserve a row and hand out a
presigned URL, the client PUTs the bytes, the client tells you it finished. The
client is a browser on a train. It will not always tell you.

So the reservation carries an expiry:

```sql
CREATE TABLE file (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state             text NOT NULL CHECK (state IN ('pending', 'ready', 'deleted')),
    storage_key       text NOT NULL,
    upload_expires_at timestamptz
);
```

And the collector looks for expired `pending` rows. Here is the version that
loses data:

```sql
-- Step 1, in the job
SELECT id, storage_key FROM file
 WHERE state = 'pending'
   AND upload_expires_at IS NOT NULL
   AND upload_expires_at < $1
 ORDER BY upload_expires_at ASC LIMIT $2;

-- Step 2, per candidate
DELETE FROM file WHERE id = $1;
```

Between the two statements the client's `completeUpload` lands. The row is now
`ready`, the bytes are in the bucket, the user can see their file in the
interface — and step 2 deletes it, because step 2 is working from what step 1
believed.

This is not a rare window. The collector runs against rows that expired *just
now*, which is exactly the traffic of a client that was slow rather than gone.

**The fix is to repeat the predicates in the `DELETE` and let it tell you
whether it won:**

```sql
DELETE FROM file
 WHERE id = $1
   AND state = 'pending'
   AND upload_expires_at IS NOT NULL
   AND upload_expires_at < $2
RETURNING storage_key;
```

Zero rows means the client completed and you must not touch the bytes. One row
means you claimed it and nothing else can. The claim is the write; there is no
window, because there is no earlier read being trusted.

Then, and only for a row you removed:

```
delete the row  ->  commit  ->  delete the bytes
```

That order, not the other one. A failure after the commit leaves an orphan,
which the second job collects. A failure the other way round leaves a row
pointing at bytes that are gone, which nothing collects and which a user meets
as a broken download. **An orphan is a recoverable failure and a dangling row is
not.**

One more thing, easy to leave out and worth the line: audit the collection. A
file that disappeared is a question somebody will ask, and "the collector took
it, at this time, because the reservation expired at that time" is a much better
answer than silence.

---

## Sealing, which is the job you only want after you needed it

If your audit log is hash-chained, replay detects an edit, a deletion from the
middle and a deletion of the first event — and **not** a deletion of the most
recent ones, because what remains is a perfectly consistent chain.

A seal is a row recording where the chain had reached at a moment in time.
Schedule it, and removing recent events stops being invisible: a head that is
behind a recorded seal is a chain that lost what came after it.

It raises the cost of a silent truncation without making one impossible —
the seals live in the same database as the events — so it is worth having and
is not a substitute for pinning the head hash somewhere outside. Both, and say
which one does what.

---

## Dry run is the default, and the record must say which one happened

Every job here deletes things on the strength of an absence. So the first
argument is `dryRun`, and it defaults to **true**: a caller who has not thought
about it gets a report, not a sweep.

That default has a consequence that bites months later. **Record the effective
mode, not the argument.** A caller who passed nothing performed a dry run, and
six weeks of those must not read as six weeks of sweeping:

```sql
mode text NOT NULL CHECK (mode IN ('dry', 'live'))
```

Text with a check, not `dry_run boolean`. Two reasons: a boolean cannot grow a
third value and this is exactly the kind of flag that eventually needs one; and
`dry_run = false` at a call site reads as a double negative at the moment you
least want to misread it.

Step 3 of the script beside this page measures what the omission looks like:
six recorded runs, a job that reports healthy by every naive query, and **zero
bytes ever actually swept**.

---

## The part nobody writes: a table of runs

Here is the whole problem in one sentence. **The output of all four jobs is an
absence**, so the difference between "ran, found nothing" and "has not run since
March" is not visible anywhere in your data. Logs scroll. Metrics have
retention. Nobody notices a cron that stopped firing until the bucket bill does.

So record the runs:

```sql
CREATE TABLE job_run (
    id          bigserial PRIMARY KEY,
    job         text NOT NULL CHECK (job IN ('storage_orphans', 'upload_reservations',
                                             'audit_trim', 'audit_seal')),
    started_at  timestamptz NOT NULL,
    finished_at timestamptz NOT NULL DEFAULT now(),
    outcome     text NOT NULL CHECK (outcome IN ('ok', 'failed')),
    mode        text NOT NULL CHECK (mode IN ('dry', 'live')),

    -- NULL, not 0, when a run threw before deciding anything. Zero is a claim.
    scanned     bigint,
    acted       bigint,

    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    error       text,

    -- A failure with no error, or a success carrying one, are both states
    -- somebody would have to interpret. Neither is representable.
    CONSTRAINT job_run_error_iff_failed CHECK ((outcome = 'failed') = (error IS NOT NULL))
);
```

Four decisions in there, each of which was an inference somebody had to make:

**`scanned` and `acted` are nullable.** A run that threw before deciding
anything did not scan zero things; it is not known what it got through. `0`
would be a claim, and an operator comparing runs would read it as a clean pass.

**The `=` between two boolean expressions** is the whole invariant: a failed run
must carry an error and a successful one must not. Written as an implication it
would allow `outcome = 'ok', error = 'connection reset'`, which is a row nobody
can act on.

**`detail` carries whether the sweep finished.** A pass that hit its `LIMIT` did
**not** complete, and an operator reading `scanned 1000, acted 3` will take it
for a complete pass unless something says `truncated: true`.

**It is not hash-chained, and that is the honest line.** This is an operational
record, not evidence. Chaining it would claim a property it does not have, and
the audit chain is the thing that carries that claim. Make it append-only the
same way — `DO INSTEAD NOTHING` on UPDATE and DELETE, plus a `BEFORE TRUNCATE`
trigger, because rules do not cover TRUNCATE — but do not dress it up as proof.

### Both failures have to be reported

When the job fails *and* recording the failure fails, say both. "The job failed"
and "we could not record that the job failed" are different problems for whoever
is on call, and reporting one of them loses the other. An unrecorded failure is
precisely the state this table exists to make impossible, so it must not arrive
as a bare `internal`.

---

## Asking "is it running", and the three answers

Now the question the table exists for. There are three states and most
dashboards collapse two of them:

| State | What it means |
|---|---|
| `ok`, 6 weeks old | it is running, late, and probably not scheduled as you think |
| `failed`, 5 minutes old | it is running and broken. A different problem, and a worse one |
| never run | the cron does not exist, or has never fired, or the deploy dropped it |

**A job that has never run is the worst case and the easiest to hide**, because
the natural query hides it for free:

```sql
SELECT j.job, now() - max(r.finished_at) AS age
  FROM (VALUES ('storage_orphans'), ('upload_reservations')) AS j(job)
  LEFT JOIN job_run r ON r.job = j.job
 GROUP BY j.job
HAVING now() - max(r.finished_at) > interval '1 day';   -- the bug
```

A job with no runs has `max(finished_at) IS NULL`, `NULL > interval` is NULL,
`HAVING NULL` is not true, and the row that should have paged you is the one row
that does not appear. Step 4 of the script measures it: the same query over the
same three jobs returns the *stale* one and silently drops the one that has
never run at all.

Say it explicitly:

```sql
HAVING max(r.finished_at) IS NULL
    OR now() - max(r.finished_at) > interval '1 day'
```

### Do not invent the cadence

The interval is a policy decision about your bucket, your bill and your
tolerance, and a default here is a number somebody made up appearing in
somebody else's alerting. Take the threshold per job from the caller, and when
no threshold was given, answer `null` for "is it stale" rather than guessing.

But when a threshold *is* given, a job that has never run is stale — immediately.
Returning `null` there would hide the worst case behind the absence of data,
which is the defect this whole section is about.

---

## What this does not give you

- **It does not make the jobs run.** A table of runs tells you the cron stopped.
  Something still has to look at it, on a schedule, and tell a person.
- **It does not replace the sweeper's own guards.** Recording that a sweep ran
  says nothing about whether it was right to delete what it deleted. See the
  [orphaned objects guide](deleting-files-and-orphaned-objects.md) for the three
  guards that part needs.
- **A run record is not an audit event.** It says a job executed; it is not
  evidence of what it did and it is not chained. If a deletion needs to be
  provable, the proof belongs in the audit log, written in the same transaction
  as the deletion.
- **Two schedulers will both run.** Nothing here is a distributed lock. If you
  run the sweep from two boxes, add one — `pg_advisory_xact_lock` on a key
  derived from the job name is enough and costs one line.

---

## If you would rather not build it

[Filelayer](https://filelayer.dev) is this shape, packaged: the three collectors
and the sealer each record a `job_run` row whether they succeed or fail, with
the effective mode rather than the argument, and `jobStatus()` answers the
three-way question above — taking the threshold from you and inventing no
cadence.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
// Nothing has run yet. `lastRun: null` is NOT "nothing to report".
const fresh = await fl.jobStatus({ staleAfter: { upload_reservations: 3600 } });
const before = fresh.find((j) => j.job === 'upload_reservations')!;
assert.equal(before.lastRun, null);
assert.equal(before.ageSeconds, null);
assert.equal(before.stale, true);   // never run, and you said it should have

await fl.collectUploadReservations({ dryRun: true });

const after = (await fl.jobStatus({ staleAfter: { upload_reservations: 3600 } }))
  .find((j) => j.job === 'upload_reservations')!;
assert.equal(after.lastRun!.outcome, 'ok');
// The EFFECTIVE mode, so six weeks of dry runs cannot read as six weeks
// of sweeping.
assert.equal(after.lastRun!.mode, 'dry');
assert.equal(after.stale, false);
```

That block is executed by `npm run check:docs` on every commit.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [How do I delete a file without leaving orphaned objects in S3?](deleting-files-and-orphaned-objects.md) —
  the second job, in full, including why it is the most dangerous one here.
- [How do I prove who accessed a file?](tamper-evident-file-audit.md) — why the
  retention job needs a checkpoint, and what sealing is for.
- [How do I let users upload files privately?](private-file-uploads.md) — where the reservations this
  page collects come from.

---

## Sources

- [`DELETE ... RETURNING`](https://www.postgresql.org/docs/current/sql-delete.html) — PostgreSQL, on claiming a row and learning whether you won
- [Comparison Functions and Operators](https://www.postgresql.org/docs/current/functions-comparison.html) — PostgreSQL, on three-valued logic and why `NULL > x` is not false
- [Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) — PostgreSQL, for the one-line scheduler lock
- [Lifecycle configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) — AWS, on what the bucket can expire for you and what it cannot
