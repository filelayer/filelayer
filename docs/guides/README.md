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

*This is the guide where Filelayer is not the answer.* We do not do direct
browser-to-storage uploads; it says what to use instead.

### [Multi-tenant file access control](multi-tenant-file-access.md)

The usual answer — `tenant_id`, Row-Level Security, a session variable — is a
good one, and this guide does not argue with it. It argues with the conclusion.
**RLS decides which rows a session may see; it does not decide which rows may
exist.** Measured: a session writes a grant joining one tenant's file to another
tenant's org and RLS accepts it. A composite foreign key refuses the same write,
including from a role with `BYPASSRLS`.

→ [`multi-tenant-file-access.proof.mjs`](multi-tenant-file-access.proof.mjs)

---

## Running the proofs

Nothing to install and no server to start: `embedded-postgres` runs a real
PostgreSQL as an ordinary user process and cleans up after itself.

```bash
npm run bootstrap        # npm ci in packages/core, once
node docs/guides/expiring-and-revocable-file-links.proof.mjs
node docs/guides/multi-tenant-file-access.proof.mjs
```

Each prints what it measured and exits non-zero if any number fails to
reproduce. Re-run them before believing any of this.

---

## Something wrong, or something missing?

A guide that is wrong is worse than no guide, because the reader trusted it
enough to paste it. If something here does not hold,
[open an issue](https://github.com/filelayer/filelayer/issues) — including
"this was confusing", which is a defect in a document whose only job is to be
clear.
