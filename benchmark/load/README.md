# Load benchmark

`npm run bench:load`

The first measurement of concurrent behaviour in this repository. Before it,
`TRUST.md` and the README both said the same thing about load: nobody had
pointed any at this. That sentence is now narrower rather than gone — see
*What this cannot see*.

## What it is not

Two things already existed and neither closed the gap:

- **`packages/core/dev/bench-authz.ts`** times `authorize()` **sequentially** on
  PGlite, which is PostgreSQL compiled to WebAssembly with a single backend. Its
  own header says the milliseconds are meaningless and only the ratios matter.
  It cannot observe contention, because on one backend there is none.
- **`packages/core/test/performance.test.ts`** asserts with `EXPLAIN` that the
  hot path uses its indexes and does not sequentially scan `file_grant`. That is
  a *plan* assertion, and a query can use a perfect index and still be the wrong
  shape. This benchmark found exactly that case, twice.

## What it measures, and why each one

Not "requests per second", which is a number with no denominator and no decision
attached. Every scenario exists because a comment in `src/` asserts something a
measurement can contradict.

| | Claim under test | Verdict |
|---|---|---|
| **H1** | The round-trip count is the latency, and nothing had ever counted them | Counted: 7, 8 or 9 statements |
| **H2** | A role-derived read is cheaper than a grant-derived one, because only the second charges the download counter | **True**, and the gap is ~35% |
| **H3** | One anonymous grant row serving every request becomes a write hotspot under load | **False as written.** See below |
| **H4** | Grant volume does not change the cost of a read | **True for table size. False for grants held by the reader** |

## Method

- A real native PostgreSQL via `embedded-postgres`, with a real `pg.Pool`. Not
  PGlite: one backend would make every concurrency column measure the same
  serial path.
- The pool is sized above the top concurrency, so a saturated pool is never
  mistaken for a saturated database.
- Closed loop: *N* workers, each issuing one operation at a time for a fixed
  duration. Not an open loop at a fixed arrival rate — that measures queueing,
  and what is wanted is service time at a known parallelism, which is what a
  pool size has to be chosen against.
- `ANALYZE` after every bulk insert. **This was missing from the first version
  and it invalidated the most dramatic result it produced**; the note in the
  source says what happened.

## What this cannot see

Quoted limits, so nobody cites this for something it did not do.

- **Byte delivery.** `FsStorage` on a local disk, so object-store latency is
  excluded on purpose: this measures the decision, not S3. A real deployment
  adds one round trip to the store on top of every number here.
- **The network.** Driver, pool and database are one machine. A managed Postgres
  adds its RTT once per statement in the H1 column — which is why H1 is reported
  as a count.
- **Any HTTP framework.** It drives `fl.readStream()` directly: no router, no
  TLS, no JSON.
- **Sustained load.** Seconds per cell. Connection leaks, memory growth and
  vacuum pressure need hours and are not measured.

A number from here is a floor on latency and a ceiling on throughput.

## Re-running it

```bash
npm run bench:load
BENCH_MS=5000 BENCH_CONC=1,8,32,64,128 npm run bench:load
```

Results land in `results.json` beside this file. [`RESULTS.md`](RESULTS.md) is
the recorded run every later one is compared against.
