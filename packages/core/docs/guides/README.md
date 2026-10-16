# Guides

Answers to questions people actually ask about user files in a SaaS application.

**The rule for everything in here:** a guide has to be useful to somebody who
never installs Filelayer. If a reader follows it and builds the thing themselves,
it did its job. A page that only ever concludes "use us" is an advertisement, and
nothing cites an advertisement.

Two consequences of that rule, both deliberate:

- **The code runs.** Every TypeScript block in these pages is executed by
  `npm run check:docs` on every commit. If a behaviour changes, the page fails
  the build instead of quietly becoming untrue.
- **The numbers are measured.** Where a guide states what happens under
  concurrency, or what PostgreSQL does, or what a constraint refuses, a script
  beside it reproduces that against a real PostgreSQL in about twenty seconds.
  A measurement nobody can re-run is an assertion in a confident voice.

---

## The guides

### [Expiring and revocable file links](expiring-and-revocable-file-links.md)

The usual answer is a presigned URL with an expiry. It is right about expiry and
wrong about taking it back: **a presigned URL cannot be revoked individually.**
What you can do instead, what each option costs, and the one query that is easy
to write wrong — with the schema, the SQL, and four measurements of what happens
when two people redeem the same link at the same moment.

→ [`expiring-and-revocable-file-links.proof.mjs`](expiring-and-revocable-file-links.proof.mjs)

### [Private file uploads](private-file-uploads.md)

The usual answer — private bucket, presigned URL — is correct as far as it goes.
What it leaves out is that **a presigned PUT does not constrain the body**: a URL
issued for a 200 KB avatar accepts three gigabytes. The presigned POST policy
that does constrain it, the content-type trap that becomes stored XSS, why the
object key is not access control, and why the upload happening outside your
transaction leaves orphans.

It also documents the option we could not find written down anywhere and ended
up needing: **sign `content-length` into the PUT**, which pins the body to an
exact size and works on Cloudflare R2, where presigned POST does not exist.

### [Multi-tenant file access control](multi-tenant-file-access.md)

The usual answer — `tenant_id`, Row-Level Security, a session variable — is a
good one, and this guide does not argue with it. It argues with the conclusion.
**RLS decides which rows a session may see; it does not decide which rows may
exist.** Measured: a session writes a grant joining one tenant's file to another
tenant's org and RLS accepts it. A composite foreign key refuses the same write,
including from a role with `BYPASSRLS`.

→ [`multi-tenant-file-access.proof.mjs`](multi-tenant-file-access.proof.mjs)

### [Deleting files and orphaned objects](deleting-files-and-orphaned-objects.md)

Postgres and S3 do not share a transaction, so every delete is two deletes. The
well-covered answer is a sweeper job. This is about what comes after: **which
delete goes first** (the row, because an orphan is recoverable and a row
pointing at nothing is not), and why **the sweeper is the most dangerous job
you will write** — it deletes on the strength of an absence, and a partial
listing is indistinguishable from one. Measured: the same short listing hides
orphans in a storage-driven sweep and destroys live rows in a DB-driven one.

→ [`deleting-files-and-orphaned-objects.proof.mjs`](deleting-files-and-orphaned-objects.proof.mjs)

### [Should I redirect to a presigned URL or proxy private files myself?](serving-private-files.md)

The usual answer is redirect to a presigned URL, and it is right about cost.
What it leaves out is that **a redirect's revocation window is the URL's
remaining TTL** — not a moment, not the next request, and no operation shortens
it. Measured against proxying, where it is one request.

And the bill that arrives with proxying: `Range` is now yours, and
**four of the five ranges that look like they deserve a `416` must be answered
`200` instead.** The whole table, measured, including the multi-range case whose
natural implementation is a silent data-corruption bug.

→ [`serving-private-files.proof.mjs`](serving-private-files.proof.mjs)

### [How do I revoke a share after the recipient has shared it onwards?](revoking-delegated-access.md)

Most writing about sharing stops at the first hop. **Whether you can revoke
onward access is decided when you store the share, not when you revoke it**: a
re-share that writes an independent row cannot be undone later, however good
your revoke endpoint is. One column and one predicate, and then the five ways
that pairing is got wrong — including the one a capability check alone lets
through, where a consultant's read access becomes a public link while
attenuation is obeyed the whole way.

Measured: a root capped at 5 delegating three children of 5, redeemed fifty
times concurrently, serves exactly 5.

→ [`revoking-delegated-access.proof.mjs`](revoking-delegated-access.proof.mjs)

### [How do I prove who accessed a file?](tamper-evident-file-audit.md)

An `access_log` answers *what did we record*. A compliance auditor asks *could
that have been changed*. A hash chain closes most of the gap and **detects three of the
four things that can be done to a log** — not truncation of the most recent
events, which is structural and is why the head has to be pinned outside the
database.

Measured, including the defect almost every implementation ships: a
SELECT-then-INSERT append forks under concurrent writers, so an honest log reads
as tampered with — and a real tamper is then indistinguishable from routine
concurrency.

→ [`tamper-evident-file-audit.proof.mjs`](tamper-evident-file-audit.proof.mjs)

### [What background jobs does a file feature need, and did they run?](background-jobs-for-user-files.md)

Four jobs. Writing them is a morning; the problem is that **every one of them
produces an absence as its output**, so a job that silently stopped running
looks exactly like a job with nothing to do.

Measured: the collector that deletes a file the user *just finished uploading*,
and the one-statement claim that closes it; six weeks of dry runs that look
green on every dashboard while nothing is ever swept; and the alerting query
that silently drops the worst case — the job that has never run at all, hidden
for free by three-valued logic.

→ [`background-jobs-for-user-files.proof.mjs`](background-jobs-for-user-files.proof.mjs)

---

## Running the proofs

Nothing to install and no server to start: `embedded-postgres` runs a real
PostgreSQL as an ordinary user process and cleans up after itself.

```bash
npm run bootstrap        # npm ci in packages/core, once
node docs/guides/expiring-and-revocable-file-links.proof.mjs
node docs/guides/multi-tenant-file-access.proof.mjs
node docs/guides/deleting-files-and-orphaned-objects.proof.mjs
node docs/guides/serving-private-files.proof.mjs
node docs/guides/revoking-delegated-access.proof.mjs
node docs/guides/tamper-evident-file-audit.proof.mjs
node docs/guides/background-jobs-for-user-files.proof.mjs
```

The last one needs no PostgreSQL server at all: it runs the database in-process
and takes about five seconds.

Each prints what it measured and exits non-zero if any number fails to
reproduce. Re-run them before believing any of this.

---

## Something wrong, or something missing?

A guide that is wrong is worse than no guide, because the reader trusted it
enough to paste it. If something here does not hold,
[open an issue](https://github.com/filelayer/filelayer/issues) — including
"this was confusing", which is a defect in a document whose only job is to be
clear.
