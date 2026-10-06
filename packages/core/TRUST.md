# Should you depend on this?

Probably not yet. This page exists so you can decide that quickly, with the real
numbers, instead of inferring it from what a README doesn't say.

Filelayer is a file layer for SaaS applications: files with owners, orgs and
roles, share links that expire and can be revoked, lifecycle, and an audit trail
that records denials. Its first release on npm was `0.3.0`, on
**6 September 2026** — the registry's own timestamp, which is a day later than
this page said until 4 October.

---

## The state of it, in numbers

| | |
|---|---|
| Version | 0.15.2 — alpha |
| Known production deployments | **0** |
| Maintainers with commit rights | **1** |
| Independent security review | **none** |
| Load measured | First run 4 October 2026, `benchmark/load/RESULTS.md`. One machine, no network, no object store, seconds per cell |
| Tests | 547, of which 539 on Node 22 / 24 / 26 and all 547 against a real PostgreSQL, every commit |
| Concurrency, against a real PostgreSQL with two backends | 8 tests, every commit |
| Adversarial suite | 27 attacks, 0 breaches |
| Runtime dependencies | **0** |
| Licence | Apache-2.0 |
| Storage adapter against live Cloudflare R2 | 12 tests every commit, 13 nightly |
| Storage adapter against live AWS S3 | 12 tests every commit, 13 nightly, `eu-north-1` only |

If any row in that table is disqualifying for you, it should be, and you can stop
reading. We would rather you decline today for accurate reasons than adopt on a
misunderstanding and discover the gap during an incident.

---

## What is actually tested

The authorization engine is the part we stand behind. There is one function that
answers every access question, and a property suite that covers cross-tenant
isolation, revocation that beats a live URL, delegation attenuation, download
caps under concurrency, audit tamper-evidence (within the limit named below),
and the full role matrix.

Two of those tests are worth naming because they are the ones that catch the
mistakes people actually make:

- **A differential test** asserts that the set query (`listFiles`) and the point
  check (`authorize`) agree exactly, over randomized corpora. If a listing ever
  returns a file the point check would deny, that is a leak, and the suite fails.
- **A calibration control.** The adversarial suite is also run against an earlier
  revision of this library that is known to be vulnerable. It scores 3 breaches
  there and 0 here. A suite that only ever passes proves nothing about itself.

## What runs against a real object store, and what still does not

**Since 30 September 2026 the storage adapter runs against live Cloudflare R2
on every commit.** Twelve tests per commit and a thirteenth nightly, in CI,
against a real bucket: put/get/head/
delete, ranged reads, prefix listing, keys containing characters that break
naive URL construction, a presigned GET the store actually honours, a presigned
URL expiring for real, a tampered one refused, and — on the nightly run and on
manual dispatch — an 11 MB multipart upload reassembled byte-exactly. Plus the
whole `Filelayer` lifecycle end to end on top of it.

Before that it had never run against anything but a local harness, and this page
said so for three weeks.

**Since 3 October 2026 the same tests also run against AWS S3 itself**,
on every commit, against a bucket in `eu-north-1` reached through a
least-privilege IAM user. R2 is S3-compatible, not S3, which is the whole reason
for running both: AWS has its own checksum requirements, real IAM evaluation,
virtual-hosted addressing and its own error codes. Until that day those were
exercised only against the local harness that recomputes every SigV4 signature —
a harness that found nine real bugs, including one where a key containing `#`
silently collided with a different object and returned the wrong file's bytes,
but which is not the counterparty.

What that still does not say: one region, one bucket configuration, and no
traffic. The tests write a handful of objects and an 11 MB multipart upload on
the nightly run. Nobody has put load on this on either provider.

The job fails, rather than passing quietly, if the credentials are present and
the suite skips itself — the one failure mode that looks exactly like success.
That check had itself never executed until the day the credentials arrived, and
it was broken: it read the runner's tally in a format the runner had stopped
emitting. Fixed the same day, and it now reads either format and also fails on a
non-zero failure count, which the first version did not.

## What is known broken or unfinished

Kept current, and complete, in
[`LIMITATIONS.md`](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md) —
fourteen entries, which ship in the npm tarball. The ones most likely to
matter:

- Byte delivery proxies through your application by default, so there is no CDN
  on that path. An opt-in redirect mode exists for anonymous grants and trades a
  bounded revocation window for cacheability.
- `Range` is answered by the shipped route helpers, with three documented
  edges: multiple ranges in one request are ignored and the whole object is
  served, `If-Range` is not parsed, and a range is dropped when a download cap
  binds (with `Accept-Ranges: none` to say so). The README limitations list
  gives the reasoning for each.
- No thumbnails, transformations or format negotiation. Bytes go in and the same
  bytes come out.
- Direct browser-to-storage upload exists as of `0.10.0` but is opt-in, S3/R2
  only, and single-PUT: no presigned POST (R2 does not implement it), nothing on
  `FsStorage`, and no resumable or multipart direct upload. Abandoned
  reservations are reclaimed by a job you schedule, not automatically. Plain
  `upload()`, where the bytes travel through your server, is still the default
  and is unchanged.
- Org admins and owners can read `private` files. Deliberate — retention and
  legal hold are useless if the people accountable for them cannot see what they
  are holding — but it is a policy decision, so it belongs on this page.
- The audit chain detects any edit to a recorded event, and the removal of one
  from the middle or the start. It does **not** detect truncation of the most
  recent events — replay walks forward and nothing records where the chain was
  supposed to end. An anchor inside the same database would not fix that, so
  `verifyAuditChain()` hands you the head hash and pinning it somewhere else is
  your job. Found by our own adversarial sweep, 2 October 2026, after three
  weeks of this page saying "tamper-evidence" without that sentence.
- Concurrency is no longer argued. **Since 3 October 2026 eight tests run on
  every commit against a real PostgreSQL with two connections**, staging the
  races rather than reasoning about them: two backends demoting two owners, ten
  simultaneous redemptions against a cap of three, twenty concurrent writers on
  one audit chain, and cross-tenant traffic under load. Three of them carry a
  calibration control that drives the same interleaving with the protection
  removed and asserts the bad outcome does occur, because a concurrency test
  that has never been seen to fail is indistinguishable from one that cannot.
  What is still unproven is everything above those four properties: this is a
  floor, not a sweep.
- The schema may change before 1.0, and **has changed six times**, not once —
  this line said "one breaking change" until `0.15.0` and was understating what
  adopting us costs. `MIGRATIONS.md` has ten numbered entries, six of them with
  forward SQL. Since `0.15.0` each of those has a runnable file under
  `migrations/`, and CI applies it to the previous release's schema and fails
  the build unless the result matches the next release's, on real PostgreSQL.
  Two of the ten cannot be verified: they predate the oldest tag in the
  repository, so there is no earlier schema to apply them to.
- Until `0.15.0` there was no way to tell which schema version a database held.
  `filelayer_schema_version` and `schemaStatus(db)` close that. There is still
  **no migration runner, and there will not be one** — applying the files is
  your runner's job, which is a product position rather than a gap.

---

## What would make this trustworthy

Not a roadmap of features. These are the specific things that would let a
sceptical engineer say yes, in the order they matter:

1. **Production deployments that are not ours.** One, then three, then ten. This
   is the only item on the list we cannot manufacture, and it is the one that
   matters most. Everything else is work; this is evidence.
2. **The storage adapter under real load, and in more than one region and
   bucket configuration.** It runs against live R2 and live AWS S3 on every
   commit; what no test here has produced is traffic.
3. **An independent security review** of `schema.sql` and `authz.ts`, published
   in full including whatever it finds. The property suite is self-asserted, and
   cross-tenant isolation is exactly the claim that needs an adversary who is not
   the author.
4. **1.0, with a frozen schema and a written compatibility promise.**
5. **A second maintainer**, and a demonstrated response time on a real report.

We will report against this list publicly, including when a number stays at zero.

---

## Using it anyway

If you want to try it, the honest framing is: this is a good design that has not
met production. Reasonable ways to engage, roughly in order of exposure:

- **Read the schema.** `schema.sql` states eight security properties. Some are
  write-side integrity constraints that bind every writer — take the composite
  foreign key that makes a cross-tenant grant row impossible to insert, even
  from `psql`. Others, including all read authorization, are enforced in
  `authz.ts` and therefore only for calls made through the library: there is no
  RLS policy in `schema.sql`, and a direct `SELECT` is not filtered. Take also
  the rule that a signed URL is re-validated on every request instead of being a
  bearer token you cannot recall. Apache-2.0 — copy it.
- **Run it against a non-critical workload** and tell us what broke.
- **Depend on it in production** only if you have read `authz.ts` yourself, or you
  are comfortable being the first.

If you do try it, [open an issue](https://github.com/filelayer/filelayer/issues)
about anything that confused you. Confusion is a defect here; the whole claim is
that this removes decisions you would otherwise get wrong quietly, and a
confusing API does the opposite.

Security reports: see [`SECURITY.md`](https://github.com/filelayer/filelayer/blob/main/SECURITY.md).
