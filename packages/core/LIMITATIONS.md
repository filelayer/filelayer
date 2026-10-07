# Limitations

The complete list. The five most likely to make you decline are in the
[README](README.md#the-five-that-make-people-decline); this is everything,
because a limitations list that lives only in a README gets trimmed for length
and the trimming is always in our favour.

Each one is current as of
`0.19.1`; where a limitation has been lifted since an earlier release, the
[changelog](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md) says so.

1. **`Range` is answered, with three documented edges.** The shipped routes
   parse the `Range` request header, return `206` with `Content-Range`,
   advertise `Accept-Ranges: bytes` on every proxied response, and answer `416`
   with `Content-Range: bytes */<size>` for a range past the end. What they do
   not do: **multiple ranges in one request** (`bytes=0-9,20-29`) are ignored
   and the whole object is served under a `200` — answering one of several
   ranges under a `206` is indistinguishable, to the client, from an answer to a
   different question; **`If-Range` is not parsed**, which is safe here only
   because an object key is a fresh UUID that is never rewritten, so the
   representation cannot change under a resuming client; and **a range is
   dropped when a download cap binds**, served whole under a `200` with
   `Accept-Ranges: none`, because charging a capped grant per seek would make
   `maxDownloads: 3` mean "three seeks".
2. **`shares.create()` is not idempotent, so a grant id is not a person's
   access.** Every call inserts a grant row. Use
   `shares.unshare(fileId, { as, user })` to remove a named user's access and
   `revoke(grantId)` only for a link whose secret you handed out. The engine
   has no dedupe: two calls with an `expiresIn` are two legitimately different
   windows, and it cannot tell those from a double-clicked button. There is
   also no bound on how many live grants one subject may hold on one file, and
   the cost of an authorized read is linear in that number --
   [`benchmark/load/RESULTS.md`](https://github.com/filelayer/filelayer/blob/main/benchmark/load/RESULTS.md)
   H4b measures 4.3 ms at five grants and 5.9 s at a hundred thousand.
3. **The tiered facade `fl.files.put()` takes a `Uint8Array`**, so a file put
   through it is fully resident in memory. The core `fl.upload()` accepts a
   `ReadableStream`; use that above a few tens of megabytes.
4. **Direct browser → storage upload is opt-in, and only S3/R2 bypass your server.**
   `createUpload()` reserves a `pending` file row and returns a presigned PUT
   whose `content-length` and `content-type` are in the SIGNED HEADERS, so the
   object store rejects a body of the wrong size or type before accepting it —
   which is the hole in the usual "just issue a presigned PUT" answer. It
   requires the verbatim `DIRECT_UPLOAD_ACKNOWLEDGEMENT` and a
   `maxUploadBytes` you choose, because an exact pin to whatever the client
   asked for is not a bound.

   **`FsStorage` is the exception, and it says so in the response.** Configured
   with an `upload` block it mints a token for `localUploadRoute()`, which you
   mount — so the client code is identical in development, and
   `PresignedUpload.via` reads `'server'` rather than `'storage'` because on
   that adapter the bytes still travel through your process. Check `via` before
   concluding otherwise. Without that config it cannot sign and answers
   `direct_upload_unsupported`.

   What it does not do: **presigned POST** (Cloudflare R2 does not implement
   it, and R2 is the default store, so the POST policy's `content-length-range`
   is not available to us — the signed-header pin is stricter anyway), and
   **resumable or multipart direct upload**, so one PUT is one object.
   `collectUploadReservations()` is a job you must schedule, or abandoned
   reservations accumulate as invisible `pending` rows. Plain `upload()` is
   unchanged and still the default: bytes through your server, no
   acknowledgement, every adapter.
5. **Org admins and owners can read `private` files.** Deliberate, since retention
   and legal hold are their responsibility. But if you need to exclude the
   operator, you need envelope encryption and we do not have it.
6. **Identifiers are unique per *project*, not per org.** `actor.external_id`
   and `org.external_id` are scoped to a project (one customer application). Two
   orgs inside one project cannot both have a user called `alice` meaning
   different people.
7. **The storage adapter has run against AWS S3 since 3 October 2026, and only
   in one region.** Twelve tests against a real bucket in `eu-north-1` on every
   commit and a thirteenth on the nightly run, alongside the same against
   Cloudflare R2. What that does not
   cover: other regions and their endpoint quirks, S3 Express One Zone, requester
   pays, object lock, cross-region replication, and any bucket policy more
   restrictive than the least-privilege IAM user the tests use.
8. **Unauthenticated callers can still append denial events to the audit chain
   of a tenant inside a project they can reach.** That is P5 working as designed.
   Denials are the events worth recording, but it is a load-bearing reason to
   rate-limit at ingest. `orgExists` is project-scoped, so the reach is bounded
   to a project the caller is already authenticated for.
9. **Orphan collection is a job you have to run.** Bytes are written before the
   metadata commits, so a crash in between leaves an unreferenced object.
   `collectStorageOrphans()` cleans them up and nothing calls it for you.
10. **Redirect delivery has a revocation window.** If you enable it, a presigned
   URL stays valid for up to its TTL after the grant is revoked. It is off by
   default, defaults to anonymous grants only, and requires passing a verbatim
   acknowledgement string. That string is the point.
11. **Truncation of the most recent audit events is detectable only if you
   seal, and only against someone who does not also remove the seals.** Replay
   catches any edit to a recorded event, the removal of one from the middle, and
   the removal of the first. It cannot catch the removal of the last *n*:
   nothing in the chain records where it was supposed to end, so what remains
   verifies cleanly. Since `0.16.0`, `sealAuditChain()` writes a row recording
   the head at a moment, and `verifyAuditChain()` reports
   `truncated_past_seal` when the head is behind one. Schedule it and routine
   truncation stops being invisible. **It is not a solution and we will not
   describe it as one**: the seal lives in the same database as the events, so
   whoever deletes the rows can delete the seals in the same transaction. The
   only fix that leaves the blast radius is still to pin `lastHash` somewhere
   your database administrator cannot rewrite and compare it on the next run.
   Doing that is your job, not ours. `UPDATE` and `TRUNCATE` are refused at the
   database; `DELETE` is refused unless a transaction declares
   `filelayer.audit_trim`; all of it is a rule and a trigger the table's owner
   can drop.
12. **The audit log is trimmable but has no retention policy of its own, and
   nothing schedules one.** Since `0.16.0`, `trimAuditChain()` removes old
   events and leaves an `audit_checkpoint` row recording the hash the chain had
   reached, so a trimmed chain still verifies and `verifyAuditChain()` reports
   an attested gap rather than tampering. Choosing a policy and running it is
   yours: nothing is trimmed unless you ask, so **`audit_event` still grows
   without bound in a deployment that never calls it.** Replay is sequential by
   construction and its TIME is linear in what the tenant has accumulated since
   its last trim; verification has been bounded in memory since `0.14.0`, which
   is a different property. A trim is attested, not prevented: the same
   privileged path that removes events can remove them without writing a
   checkpoint, and that is reported as tampering, which is the point.
13. **`fl.store` and `fl.store.db` are public, and nothing on them authorizes
   anything.** `PostgresStore` is the engine's dependency surface: every method
   on it reads and writes rows directly, with no capability check and no audit
   event. It is exported, and `fl.store.db` reaches the raw query interface, so
   **any code running in your process that holds a `Filelayer` can read or
   change any tenant's files and leave no trace in the log.** That is not a
   hole to be closed -- an engine whose store it cannot reach is an engine that
   cannot work, and the same is true of the `pg.Pool` you handed us, which you
   already hold. It is a statement about where the boundary is: the boundary is
   your process, and `authorize()` protects it from the outside, not from the
   inside. Treat `fl.store` the way you treat your database credentials.
   `@filelayer/sdk`, when it exists, must not re-export it.
14. **A proxied delivery is audited at the decision, not at the last byte.** The
   allow event and the download-cap charge happen before any bytes move, so a
   transfer that dies mid-stream is recorded as an allowed read and still spends
   the cap. "Every access on the record" means every authorization decision. On
   the redirect path a `file.deliver` event does record the handoff; on the proxy
   path there is no event that says the bytes arrived.

---

## Why this is a separate file

It was 117 of the README's 528 lines, which a reader pointed out on 5 October
2026 reads as fragility rather than as candour -- and he was right about the
effect even though the content is the point. Moving it changes nothing about
what is disclosed: it ships in the npm tarball, so an install has it on disk,
and the README keeps the five that would actually make somebody walk away.

What is NOT the reason: shortening the list. If anything here is ever removed
rather than fixed, that is a defect in this file.
