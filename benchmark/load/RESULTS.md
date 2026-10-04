# Load benchmark — 4 October 2026

The first recorded run, and the one every later run is compared against.
`@filelayer/core@0.10.0`. Method and limits in [`README.md`](README.md); the
numbers below are a floor on latency and a ceiling on throughput.

One machine, native PostgreSQL via `embedded-postgres`, `FsStorage` on tmpdir,
1.5 s per cell, pool sized above the top concurrency.

---

## H1 — round trips per authorized read

| Path | Statements |
|---|---|
| Owner read (role-derived) | **7** |
| Anonymous read via a public grant | **8** |
| Member read via an actor grant | **9** |

Reported as a count rather than a time because that is the part that travels.
On this machine a statement is tens of microseconds; on a managed Postgres one
network RTT away, nine statements is nine RTTs, and that term will dominate
everything else on this page. A reader can predict their own latency from their
own RTT; they cannot predict it from our milliseconds.

The two extra statements on the grant path are the grant lookup and
`consume_download`. The owner path does neither.

---

## H2 — a role-derived read is cheaper, and the gap is the download counter

| Concurrency | Owner read | Actor grant | Delegation depth 5 |
|---|---|---|---|
| 1 | 0.79 ms / 1 216 ops/s | 1.01 ms / 951 | 1.20 ms / 824 |
| 8 | 2.92 ms / 2 561 | 3.98 ms / 1 933 | 4.45 ms / 1 768 |
| 32 | 11.50 ms / 2 668 | 20.59 ms / 1 525 | 18.10 ms / 1 741 |
| 64 | 22.04 ms / 2 759 | 39.48 ms / 1 545 | 43.35 ms / 1 471 |

p50 / throughput. **True as documented.** An owner read costs about 65% of a
grant read, and the difference is the `UPDATE` that spends the download counter
plus the grant lookup. `#reserve` charges that counter only when authority came
through a grant, and the asymmetry is visible at every concurrency.

Delegation depth 5 costs roughly the same as depth 1 — the recursive liveness
walk is not the expensive part at these depths.

---

## H3 — the predicted write hotspot did not appear

`filelayer.ts` says, in the comment on `#reserve`:

> for a TIER-1 PUBLIC ASSET, where one anonymous grant row serves every request,
> that single row becomes a write hotspot under load.

That was written from reasoning. Measured, with one anonymous grant row serving
every request:

| Concurrency | p50 | p99 | ops/s |
|---|---|---|---|
| 1 | 1.29 ms | 1.55 ms | 764 |
| 8 | 3.87 ms | 5.55 ms | 2 021 |

It scales the same way the actor-grant path does, which is to say it is bounded
by the same `UPDATE` rather than by contention on one row. **At this scale the
prediction is not observable.** Row-level lock contention on a single row needs
far more concurrent writers than 64 to show up as a knee, so the honest reading
is "unconfirmed at 64", not "false". The comment should say *predicted and not
yet reproduced* rather than stating it as a property.

---

## H4a — table size does not change the cost of a read

100 → 100 000 grants on one file, each to a **distinct** subject, concurrency 8:

| Grants | Owner | Anonymous | Delegation depth 5 |
|---|---|---|---|
| 100 | 2.29 ms | 3.78 ms | 4.19 ms |
| 10 000 | 2.32 ms | 3.92 ms | 4.28 ms |
| 100 000 | 2.37 ms | 3.87 ms | 4.32 ms |

**Flat.** A thousandfold increase in `file_grant` costs a read 3% to 8%. The
claim holds, and the indexes are doing what `performance.test.ts` says they do.

---

## H4b — the cost IS linear in the grants held by the reader

The same table, the extra grants pointed at the **same (file, subject) pair**
the delegated read resolves. Concurrency 8:

| Grants on that pair | Owner read | Delegated read | ops/s |
|---|---|---|---|
| ~5 (baseline) | 2.27 ms | **4.32 ms** | 1 841 |
| 1 000 | 2.26 ms | **55.2 ms** | 148 |
| 10 000 | 2.26 ms | **576.7 ms** | 15 |
| 100 000 | 2.28 ms | **5 911 ms** | 1 |

The owner read is untouched at 2.3 ms throughout, so this is specific to the
subject whose grants accumulated.

**The cause.** `live_grant` is
`file_grant WHERE revoked_at IS NULL AND grant_is_live(id)`, and
`grant_is_live` is a recursive SQL function declared `COST 100`. It is evaluated
**once per matching row**. A subject holding *n* live grants on a file therefore
pays *n* recursive chain walks on every read. The index is correct and in use;
there is simply no bound on *n*.

**Why that is reachable.** `share()` inserts a new grant row on every call and
**does not dedupe**. Verified: calling `share()` 300 times for the same file and
the same subject through the public API produces 300 live rows. So a retry loop,
or a nightly sync that re-shares, accumulates them — and 1 000 rows is a 13×
degradation, which is well inside what a bug can produce in a week.

Anyone holding `share` on a file can do this to a specific reader. It denies
service to that reader only, through the documented API, with no rate limit and
no dedupe in the way. Recorded here rather than filed as a vulnerability because
it needs the `share` capability, degrades one subject's reads and reverses the
moment the duplicates are revoked — but the latency cliff is real and nothing
currently stops it.

---

## The thing this benchmark got wrong first

The first version of the harness bulk-inserted grants and measured immediately,
without `ANALYZE`. It reported the delegated read going from 12 ms to **6
seconds** and attributed it to table size, which would have been a false
architectural finding. Isolated:

| 100 000 grants, same query | Median | Plan |
|---|---|---|
| Before `ANALYZE` | **23.0 ms** | `grant_file_subject_type_idx`, 100 000 rows filtered |
| After `ANALYZE` | **1.82 ms** | `grant_subject_idx`, 5 rows |

12.6×, entirely from `pg_statistic` being stale. Two things follow.

**For the harness:** it now runs `ANALYZE` after every bulk insert. A load
harness that reports the planner's cold start as the product's throughput is
worse than no harness, because it produces numbers somebody acts on.

**For a deployment, and this one is worth documenting:** immediately after a
bulk grant import — a migration from another system, a seed, a restore —
authorized reads are an order of magnitude slower until autovacuum analyzes
`file_grant`. Run `ANALYZE file_grant` at the end of any bulk load rather than
waiting for it.

It also shows a sharp edge in the schema: under bad statistics the planner
prefers `(file_id, subject_type)` and applies both `subject_id` and the
`COST 100` function as a filter over every actor grant on the file. An index on
`(file_id, subject_id) WHERE revoked_at IS NULL AND subject_type = 'actor'`
makes that plan unavailable rather than merely unlikely; measured on the same
corpus it turns the filter into an index condition. Not shipped — it is a schema
change and `0.10.0` has just gone out.
