# TIER 5 — DESIGN NOTE

**Large files, streaming, range requests, CDN delivery, processing hooks.**

Current as of `@filelayer/core` **0.4.4**. This is a design note, not a
changelog: most of what it describes is still **not built**. Its purpose is to
establish whether the tier 1–4 design precludes any of it, and to name exactly
what breaks so that a future implementer is not surprised.

Where a piece has since landed, it is marked **LANDED** and the note says what
actually shipped, including where what shipped is narrower than what this note
argued for.

---

## 0. THE ONE-PARAGRAPH ANSWER

**The authorization model does not break. The data plane does.**

All five tier-5 capabilities are byte-path problems, and the byte path is the
one part of Filelayer that is deliberately ignorant of authorization. P2 says
storage location is never an input to an access decision; `StorageAdapter` takes
an opaque key and moves bytes and cannot be asked who may read them. That
ignorance, which exists for security reasons, is also what makes the data plane
replaceable without touching `authz.ts`, `schema.sql` or the grant model.

**Nothing in tiers 1–4 has to be undone.** One thing has to be *chosen* rather
than derived: whether to trade P4's immediacy for CDN economics on public files.
§4 prices that choice and describes the narrow, opt-in form in which `0.3.0`
took it.

---

## 1. WHAT BREAKS, ITEM BY ITEM

### 1.1 Large files — **broke in one function signature; half fixed**

`StorageAdapter.put(key, body: Uint8Array, contentType)` and
`Filelayer.upload(principal, orgId, { body: Uint8Array })`.

A `Uint8Array` means the entire object is resident in memory twice — once in the
caller, once in the library. Above ~100 MB this is not slow, it is wrong: a 2 GB
video upload is a 4 GB heap spike and an OOM.

**What had to change:** `body: Uint8Array | ReadableStream`, and a multipart
path on the S3 adapter.

**LANDED, partially.** `PutBody = Uint8Array | ReadableStream<Uint8Array>` in
`storage.ts`, and `upload()` accepts a stream, so the core path no longer
buffers. Two things did **not** land and are still open:

- the tiered facade `fl.files.put()` still takes a `Uint8Array`, so the most
  ergonomic entry point is still the one that holds the whole object in memory;
- there is still **no multipart and no resumable upload**. A failed large upload
  restarts from zero, and a single `PUT` of a multi-gigabyte object is at the
  mercy of one TCP connection.

**What does NOT change:** the authorization decision. `upload` authorizes
`create_file` on the org *before* any byte moves, and that decision is
independent of the body's shape. The `file` row is already created in `pending`
state and `lifecycleDenial()` already refuses reads of a `pending` file — which
is precisely the state machine a multipart upload needs. **This was designed
for and is unused.** Multipart is `pending` → parts → `ready`.

**The new security question, and it is real:** a multipart upload issues an
upload id that lives longer than the request that created it. That is an
authority with a lifetime, i.e. a grant, and it should be one — a `write`-capable
grant with an expiry, so P4 covers uploads and not only downloads. If it is
implemented as an opaque S3 upload id instead, that reintroduces exactly the
"credential the system cannot see, list or revoke" defect this library exists to
remove.
**Recommendation: model the upload session as a `file_grant` row.** The schema
already supports it (`capabilities` includes `write`); no change needed.

### 1.2 Streaming reads — **does not break. LANDED.**

`StorageAdapter.stream()` exists and is implemented on both adapters, alongside
`head()` and an optional `list()`. Delivery can stream rather than buffer, and
`toStreamResponse()` returns a streaming WHATWG `Response`.

The authorization decision happens once, before the first byte, which is correct
and unchanged. The only subtlety: a long-lived stream can outlive a revocation
issued mid-transfer. That is inherent to streaming — S3 has it too — and the
correct answer is a bounded response, not a re-check per chunk. It is stated in
`packages/core/SEMANTICS.md` rather than pretended away.

### 1.3 Range requests — **the largest single piece of work. Half landed.**

**LANDED:** `StorageAdapter.stream(key, { start, end })` and a `ByteRange` type;
the S3/R2 adapter issues a ranged `GET` and the in-memory adapter slices. The
delivery API can be handed a range.

**NOT landed, and this is the part a browser cares about:** the shipped HTTP
route helpers — `fileDownloadRoute()` and `shareDownloadRoute()` — do not parse
the `Range` *request* header and never return `206 Partial Content`. There is no
`Content-Range`, no `Accept-Ranges`, no `If-Range`/ETag handling. A browser
still cannot seek in a file served by the shipped routes. The parts exist; the
route that assembles them does not. This is limitation 1 in the README and item
3 in §5 of [`ARCHITECTURE-PROGRESSIVE.md`](../ARCHITECTURE-PROGRESSIVE.md).

**What does NOT change:** authorization — a range request is a read, authorized
identically.

**What still needs a decision:** the download counter. P6 says `max_downloads`
is enforced by an atomic reservation, and `0.3.0` widened that from "charged on
share-link redemption only" to "charged whenever bytes leave through a grant, on
any path". That fix makes the range problem sharper rather than softer: a video
player issues *dozens* of range requests for one viewing, and under the current
rule each one would be a charge, so `maxDownloads: 3` would mean "a third of one
video". The underlying truth is that **`max_downloads` counts requests, and what
a user means by a download is a session.** Whoever adds `206` must either count
sessions (the first range of a new redemption) or exclude ranged reads from the
counter — and say which, in `SEMANTICS.md`, before shipping it.

### 1.4 CDN-fronted delivery — **the genuine architectural tension.** See §4.

### 1.5 Processing hooks (thumbnails, transcode, virus scan) — **does not break**

These are consumers of `file`, not of `authorize()`. A worker holds the service
identity and reads the row directly; it is not an untrusted principal.

Three notes for whoever builds it:

- The derivative is a **new file**, and it must inherit the original's `org_id`
  and `visibility`. If a thumbnail of a private HR document is created with the
  default visibility of some worker's org, that is a cross-tenant disclosure with
  our name on it. This wants a first-class `derived_from` column so the
  invariant is structural rather than remembered. **That is the one schema
  change tier 5 genuinely wants**, and it is additive.
- A processing hook that *renders* untrusted content (a PDF thumbnailer, an
  Office converter) is a sandbox-escape target. That is an infrastructure
  problem, not an authorization one, and it is where every file-processing
  vendor has had its worst CVEs.
- Virus scanning wants the `pending` state to mean "uploaded, not yet
  released", which is what it already means.

---

## 2. WHY A PROXY DATA PLANE IS AFFORDABLE HERE AND NOWHERE ELSE

The frame for everything above is a property of the workload, not of the
implementation:

> **Proxying costs nothing on private files and everything on public ones.** A
> private document is read a handful of times by the small set of people
> entitled to read it, so the origin is on the path anyway and a cache in front
> of it would have a near-zero hit rate. Public media is the opposite: one
> object, unbounded readers, a cache hit rate approaching 100% — and no access
> decision to make, because the answer is always yes.

So the cost of enforcing on every request is a rounding error exactly where
enforcement matters, and is the dominant cost exactly where it does not. That is
not a coincidence to be grateful for; it is the same fact stated twice, and it is
why the byte path can afford to be a proxy for the workloads this library is for.

It also means the forfeits are asymmetric and should be stated as such:

| Forfeit | Cost on private B2B documents | Cost on public media |
|---|---|---|
| No CDN | negligible — few readers per file, cache hit rate near zero anyway | severe — you are paying origin egress for content a cache would serve |
| No `206` from the shipped routes | little — documents and PDFs are fetched whole | total — a browser cannot seek, so video and audio are unusable |
| Proxying every byte | you were going to hit the origin regardless | every byte crosses your server twice for no access decision |

Redirect delivery (§4) is the escape hatch for the right-hand column, and it is
opt-in precisely because the right-hand column is not the workload this library
is designed around.

---

## 3. CAN THE CURRENT DESIGN ACCOMMODATE BOTH PATHS? — **YES**

The question was posed as a yes/no and it deserves a direct answer: **yes, and
without a schema change**, because the grant model already contains the
partition.

A file is safe to serve from a cache **iff its only live grant is `anonymous`**.
That is not a heuristic; it follows from what an anonymous grant means. Everyone
may read it, so an edge copy discloses nothing the origin would not disclose to
the same caller.

Conversely, a file reachable through an `actor`, `org`, `role` or `link` grant
must never be cached, because:

- the cache would answer the request, so P4 (revocation beats a live URL) dies;
- the cache would answer the request, so P6 (the atomic download counter) dies;
- the cache would answer the request, so P5 (every access is audited) dies.

Three properties, one cause. The partition is therefore **not a policy anyone
chooses**, it is a consequence of the model, and it is one SQL predicate:

```sql
subject_type = 'anonymous'
```

Note that this held when the subject enum grew. Group grant subjects added `org`
and `role` to `grant_subject` after this note was written, and the predicate did
not have to change — the new subjects are principal *sets*, which is precisely
the case that must not be cached, so they fall on the correct side of a
partition that never mentioned them.

So the mixed data plane is:

```
GET /f/:id     anonymous grant only         -> safe to cache, IF you accept §4
GET /d/:secret link grant                   -> never cacheable, always proxied
GET /files/:id actor/org/role grant or role -> never cacheable, always proxied
```

which is exactly the route structure that exists today. **The seam is already
cut in the right place.**

---

## 4. THE ONE TRADE THAT CANNOT BE DERIVED

**A CDN cache is a copy of an authorization decision. A copy of a decision
outlives the decision.**

If `/f/:id` were served with `Cache-Control: public, max-age=300`, then
`fl.files.unpublish(id)` would stop working for up to 300 seconds at every edge
holding a copy. P4 degrades from *immediate* to *eventual*.

This matters more than the arithmetic suggests, because it is the specific
failure mode the product exists to refuse. `schema.sql` says of P4: *"If we ever
relax it for performance, we have no product."* A 300-second window is a
relaxation for performance. It is a small one, and an image CDN's is unbounded —
but the difference would become quantitative rather than categorical, and
"revocation is immediate, except on public files, for up to five minutes" is a
materially weaker sentence than "revocation is immediate".

The bounded costs:

| Edge TTL | Origin reads | `unpublish()` latency | P4 statement |
|---|---|---|---|
| **0 (the proxied default)** | 100% | immediate | "immediate", unqualified |
| 60 s | ~1.7% | ≤ 60 s | "immediate for private; ≤60 s for public" |
| 300 s | ~0.3% | ≤ 300 s | as above, ≤ 5 min |
| Cache + purge-on-revoke | ~0.3% | ≤ 60 s, best-effort | "immediate, unless the purge fails" |

The fourth row deserves a warning. Purge-on-revoke *sounds* like it recovers the
property and does not: CDN purge is asynchronous, is not transactional with the
database, and fails silently. A property that depends on a best-effort remote
call is not a property, it is a hope — and it would be *worse* than an honest
TTL, because the honest TTL at least has a stated bound.

### What `0.3.0` actually did — **LANDED, in the narrow form**

The proxied path is unchanged and unconditional: `deliveryHeaders()` still emits
`private, no-store, no-cache, must-revalidate, max-age=0`, and there is no TTL
knob on it. No cacheable public route was added.

What was added is **redirect delivery**, which reaches the same economics from
the other direction. Instead of letting an edge cache answer *for* the origin,
the origin answers every request — authorizing and auditing it exactly as
before — and then hands back a `302` to a short-lived presigned URL, so the
bytes never traverse the process. The residual window is the same shape as a
cache TTL and is bounded the same way, but the decision is never delegated:

- revocation is **immediate at decision time** — after a revoke, no new redirect
  is issued — and the residual window applies only to a URL already handed out,
  which the object store will honour until it expires. Nobody can recall it; the
  object store's own answer is "rotate the signing credential", which revokes
  every URL for every tenant at once and is not a per-grant control;
- the TTL defaults to **60 s** and is **clamped to 300 s** regardless of what is
  configured — clamped rather than rejected, so a config asking for a day keeps
  working at five minutes instead of tempting someone to remove the bound;
- **only `anonymous` grants are redirected** unless the scope is widened
  deliberately, so the default residual window is a window onto an object that
  is already public;
- the configuration **does not typecheck** without a verbatim acknowledgement
  string, so the trade appears in the diff and in a grep of the codebase;
- every redirected delivery writes a `file.deliver` audit event carrying the
  mode, the TTL and the resulting window, so *"which deliveries left our
  control?"* is answerable from the log rather than from a config file;
- the presigned URL pins `response-content-type` and
  `response-content-disposition`, so the object store serves the same
  neutralised type and `attachment` disposition the proxied path would have — a
  redirect does not lose the response-header protections.

**What is still not taken:** an edge-cached public route with a TTL. That
remains a choice rather than a derivation, and the default stays at the
property, not the economics.

---

## 5. SUMMARY TABLE

| Tier-5 capability | Authorization model | Schema | Data plane | Status and verdict |
|---|---|---|---|---|
| Streaming reads | unchanged | unchanged | `stream()`, `head()`, `toStreamResponse()` | **Landed.** In-flight revocation is inherent to streaming and is documented, not solved. |
| Large files | unchanged | unchanged (`pending` state already exists) | `upload()` takes a `ReadableStream` | **Landed for streaming, not for multipart.** No resumable upload; `fl.files.put()` still buffers. Model any future upload session as a `write` grant, not as an opaque object-store upload id. |
| Range requests | unchanged | unchanged | `stream(key, {start,end})` landed; `206` from the shipped routes did not | **Not precluded, not delivered.** The largest remaining piece. Forces the "does `max_downloads` count requests or sessions?" decision first. |
| CDN delivery | unchanged | unchanged | cache only `subject_type='anonymous'` | **Taken in a narrow, opt-in form** — redirect delivery, clamped TTL, anonymous grants by default, audited. An edge-cached public route is still not offered. |
| Processing hooks | unchanged | wants an additive `derived_from` | worker path | **Not precluded, not built.** The derivative must inherit `org_id` + `visibility`; make that structural rather than remembered. |

**No row says "requires redesign."** The tier 1–4 decisions do not preclude tier
5. The two things tier 5 wants from us that we do not have are a streaming byte
path and one additive column, and the one thing it wants that we should refuse
by default is a cache.
