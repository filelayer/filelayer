# Should you depend on this?

Probably not yet. This page exists so you can decide that quickly, with the real
numbers, instead of inferring it from what a README doesn't say.

Filelayer is a file layer for SaaS applications: files with owners, orgs and
roles, share links that expire and can be revoked, lifecycle, and an audit trail
that records denials. It was first published on **6 September 2026**.

---

## The state of it, in numbers

| | |
|---|---|
| Version | 0.3.0 — alpha |
| Known production deployments | **0** |
| Maintainers with commit rights | **1** |
| Independent security review | **none** |
| Tests | 313, on Node 22 / 24 / 26, every commit |
| Adversarial suite | 27 attacks, 0 breaches |
| Runtime dependencies | 0 |
| Licence | Apache-2.0 |
| Storage adapter against live AWS/Cloudflare | **never run** — see below |

If any row in that table is disqualifying for you, it should be, and you can stop
reading. We would rather you decline today for accurate reasons than adopt on a
misunderstanding and discover the gap during an incident.

---

## What is actually tested

The authorization engine is the part we stand behind. There is one function that
answers every access question, and a property suite that covers cross-tenant
isolation, revocation that beats a live URL, delegation attenuation, download
caps under concurrency, audit tamper-evidence, and the full role matrix.

Two of those tests are worth naming because they are the ones that catch the
mistakes people actually make:

- **A differential test** asserts that the set query (`listFiles`) and the point
  check (`authorize`) agree exactly, over randomized corpora. If a listing ever
  returns a file the point check would deny, that is a leak, and the suite fails.
- **A calibration control.** The adversarial suite is also run against an earlier
  revision of this library that is known to be vulnerable. It scores 3 breaches
  there and 0 here. A suite that only ever passes proves nothing about itself.

## What has never run

**The S3/R2 storage adapter has never executed against live AWS or Cloudflare
credentials.** It is exercised against a local harness that recomputes every
SigV4 signature, which found nine real bugs — including one where a key
containing `#` silently collided with a different object and returned the wrong
file's bytes. But a faithful harness is not the counterparty. TLS, real IAM
evaluation, R2's divergences from S3, throttling behaviour and the exact error
codes a real store returns are all unverified.

The CI job for this exists and is wired. It runs the moment credentials are
configured, and until then it says so out loud in the build summary rather than
passing quietly.

## What is known broken or unfinished

Kept current, in [`README.md`](https://github.com/filelayer/filelayer/blob/main/README.md#limitations). The ones most likely to
matter:

- Byte delivery proxies through your application by default, so there is no CDN
  on that path. An opt-in redirect mode exists for anonymous grants and trades a
  bounded revocation window for cacheability.
- The shipped HTTP route helpers do not parse `Range`, though everything beneath
  them honours it.
- Concurrency guarantees are argued from Postgres semantics and tested on a
  single-backend engine. The lock ordering is reasoned and followed, not proven
  under real contention.
- The schema may change before 1.0. One breaking change has already shipped, with
  a migration.

---

## What would make this trustworthy

Not a roadmap of features. These are the specific things that would let a
sceptical engineer say yes, in the order they matter:

1. **Production deployments that are not ours.** One, then three, then ten. This
   is the only item on the list we cannot manufacture, and it is the one that
   matters most. Everything else is work; this is evidence.
2. **The storage adapter proven against live R2 and S3 in CI**, on every commit.
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

- **Read the schema.** `schema.sql` states eight security properties and enforces
  them at the data layer. If you take nothing else, take the composite foreign
  key that makes a cross-tenant grant unrepresentable rather than merely filtered
  out, and the rule that a signed URL is re-validated on every request instead of
  being a bearer token you cannot recall. Apache-2.0 — copy it.
- **Run it against a non-critical workload** and tell us what broke.
- **Depend on it in production** only if you have read `authz.ts` yourself, or you
  are comfortable being the first.

If you do try it, [open an issue](https://github.com/filelayer/filelayer/issues)
about anything that confused you. Confusion is a defect here; the whole claim is
that this removes decisions you would otherwise get wrong quietly, and a
confusing API does the opposite.

Security reports: see [`SECURITY.md`](https://github.com/filelayer/filelayer/blob/main/SECURITY.md).
