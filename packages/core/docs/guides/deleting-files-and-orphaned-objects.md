# How do I delete a file without leaving orphaned objects in S3?

The usual answer is right and well covered: Postgres and S3 do not share a
transaction, so every delete is two deletes, and when only one of them runs the
two systems drift apart. Run a periodic job that compares the bucket with the
database and removes the difference. Several good write-ups say exactly this.

This guide is about the two things that come after that answer, both of which
are where the real damage happens:

1. **Which delete goes first**, because one ordering fails invisibly and the
   other fails in your users' faces.
2. **The sweeper is the most dangerous job you will write**, because it deletes
   on the strength of an *absence* — and an absence is exactly what a partial
   answer looks like from inside the job.

Everything below was measured. The script is
[beside this file](deleting-files-and-orphaned-objects.proof.mjs): a real
PostgreSQL, a real directory, about twenty seconds.

---

## Delete the row first

Two deletes, two orderings, two different failures when the process dies between
them:

| Order | Crash in the middle leaves | What the user sees |
|---|---|---|
| Object first, then row | a row pointing at nothing | every read of that file is an error |
| **Row first, then object** | an unreferenced object | nothing — it costs money, silently |

The orphan is strictly the better failure, and it is the one you can clean up
later. A row with no bytes is a user-visible defect you cannot repair, because
the bytes are gone.

So: **commit the row deletion, then delete the object, and accept that the gap
produces orphans.** The sweeper exists to reclaim them. That is the whole design
— not a workaround for one, but the deliberate choice to fail in the direction
you can recover from.

The same reasoning runs backwards on the way in, which is why an upload writes
the bytes *before* it commits the row. Same trade, same direction: an orphan
rather than a broken reference.

---

## The sweeper, and the thing nobody writes down

The job is simple to describe. List the objects, load the referenced keys,
delete the difference. Measured on a healthy run — six live files, one genuine
orphan:

```
full, correct listing        deleted  1   live files lost: none
```

It works. Now break the listing in the most boring way available: it loses its
second page. No error, no exception, just three keys where there should have
been seven.

```
partial listing, no error    deleted  0   live files lost: none
```

Nothing happened. The job is *storage-driven* — it walks objects and asks the
database about each one — so a short listing means it considers fewer objects
and misses orphans. Wasteful, not destructive.

Now run the identical bug through the other natural shape of the same job, the
one that walks **rows** and asks storage whether each object is still there:

```
partial listing, DB-driven   rows deleted  3   rows left: 3 of 6
```

**Three live files erased from the database**, their bytes now unreferenced, by
a job that completed without error and reported success. Nothing was wrong with
the rows. The listing was short, and the job read *short* as *absent*.

That is the whole lesson, and it is worth stating plainly:

> A sweeper turns "I could not see it" into "it does not exist", and then
> deletes. The two inputs are indistinguishable from inside the job, and one of
> them is a catastrophe.

### `catch { return [] }` is how it happens

The listing does not usually lose a page. It usually throws — a permissions
change, a credential rotation, a network blip, a directory that is not
readable — and someone has wrapped it defensively:

```js
async function listObjects() {
  try {
    return await storage.list(prefix);
  } catch {
    return [];              // looks careful. is not.
  }
}
```

Measured, with that exact swallow:

```
swallowed error, storage-driven   deleted 0   live files lost: none
```

Harmless *in that direction*. The same line in a DB-driven sweep deletes every
row in the table, because every object now appears to be missing. **Same line of
code, opposite catastrophe, depending on which way the job runs.** That is not a
property you want a system to have.

This is not hypothetical for us: a storage adapter in this repository returned
`{ entries: [] }` for a directory it could not read, which is precisely this bug
one layer down, and it was caught by an adversarial review rather than by a
test. The fix was to let `EACCES` propagate and reserve the empty answer for a
store that genuinely has nothing in it.

### And an upload in flight looks exactly like an orphan

Bytes on disk, row not committed yet. From the sweeper's point of view that is
an unreferenced object, and it is right — for about another eight milliseconds.

```
no grace period     deleted  2   INCLUDING the in-flight upload
```

The user watched the upload succeed and then found a broken file. Nothing in the
logs says anything went wrong, because from the job's perspective nothing did.

---

## The three guards

```js
async function sweep({ graceSeconds = 3600 } = {}) {
  // 1. The listing reports whether it is COMPLETE. A short answer is an
  //    error, not a short list. Exhaust the cursor; do not trust one page.
  const listing = await storage.list(prefix);        // throws on failure
  if (!listing.complete) {
    throw new Error('refusing to sweep: the listing did not report itself complete');
  }

  const referenced = await db.referencedKeys();      // and this one throws too

  const cutoff = Date.now() - graceSeconds * 1000;
  for (const object of listing.keys) {
    if (referenced.has(object.key)) continue;
    // 3. Too young to judge. An upload in flight has bytes and no row.
    if (object.lastModified > cutoff) continue;
    await storage.delete(object.key);
  }
}
```

1. **Completeness is part of the answer.** Not "here are some keys" but "here
   are the keys, and I saw all of them". If your storage client cannot tell you,
   exhaust the pagination yourself and fail loudly when a page errors.
2. **Errors propagate.** Never catch-and-return-empty in a job whose empty case
   means *delete*. If you must degrade, degrade to doing nothing, explicitly.
3. **A grace period.** An hour is generous and costs nothing: an orphan that
   survives one pass is collected on the next. A file deleted mid-upload is
   gone.

Measured, same three broken inputs:

```
complete listing + grace period   deleted  0   in-flight survived: true
partial listing                   REFUSED
listing that throws               REFUSED
```

Nothing lost. Note that it also declined to collect the genuine orphan in that
run, because the orphan was young too — **and that is correct.** It will be
collected on the next pass. A sweeper that does nothing is a sweeper you can run
again.

---

## Four smaller things

**Dry run first, and make it the default.** This job's whole output is a list of
things it is about to destroy. Print the list, count it, and compare the count to
what you expect before you let it act. A sudden jump from 3 to 30,000 is the
signal that something upstream is broken, and it is only a signal if somebody
sees it.

**Soft delete does not reclaim anything.** If `deleted_at` is set and the row
remains, the key is still referenced and the sweeper will skip it forever. Soft
deletion needs a *second* job that hard-deletes rows past their retention and
lets the sweeper collect what they pointed at. People reach for soft delete
believing it is the safer option; for storage it means the bytes are never
reclaimed until you write that second job.

**Versioned buckets do not delete.** If versioning is on, `DeleteObject` writes a
delete marker and keeps every version, and you keep paying for all of them. Use
a lifecycle rule for noncurrent versions, and check this before concluding your
sweeper is not working.

**Scope the listing and the query to the same thing.** The sweeper compares two
sets. If one is scoped per-tenant and the other is not, or they use different
prefixes, the difference is garbage and the job deletes on it. Compare the
sizes of both sides before taking the difference; if one is empty and the other
is not, stop.

---

## If you would rather not build it

[Filelayer](https://github.com/filelayer/filelayer) ships this job as
`collectStorageOrphans()`. It is storage-driven, it defaults to `dryRun: true`,
it has a grace period floored at 60 seconds, and its adapters raise rather than
return an empty listing for a store they could not read — the last one because
they did not, once, and a review caught it.

**It is a job you schedule, not something that happens for you.** Bytes are
written before metadata commits, so a crash in between leaves an unreferenced
object. Nothing calls it on your behalf, and the documentation says so rather
than leaving you to find out from a bill.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
// The default is a dry run: it reports what it would delete and deletes nothing.
const planned = await fl.collectStorageOrphans();
assert.equal(planned.deleted, 0, 'a dry run deletes nothing');

// `truncated` tells you the listing did not finish, so the count is a floor
// rather than an answer -- which is the distinction this whole guide is about.
assert.equal(typeof planned.scanned, 'number');
assert.equal(typeof planned.truncated, 'boolean');
```

That block is executed by `npm run check:docs` on every commit.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [Private file uploads](private-file-uploads.md) — the other end of the same
  gap: the upload that happens outside your transaction is what creates these
  orphans.
- [Expiring and revocable file links](expiring-and-revocable-file-links.md)
- [Multi-tenant file access control](multi-tenant-file-access.md)

---

## Sources

- [Clean up orphaned S3 objects](https://neon.com/guides/clean-up-orphaned-s3-objects-neon-branching) — Neon, on why the two deletes drift apart
- [Deleting orphan files](https://docs.aws.amazon.com/glue/latest/dg/orphan-file-deletion.html) — AWS Glue
- [Deleting object versions from a versioning-enabled bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html) — AWS, on delete markers
