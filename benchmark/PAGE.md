# One file feature, built five ways

A B2B document workspace, built five times: once with Filelayer and four times
the way each platform's own documentation recommends. Then the same scripts
count what each one asks the developer to write and to get right, and the same
26 attacks are run against every version that can run.

The workspace is the same in all five: organizations and roles, upload,
per-role access, share links with an expiry, a password and a download cap,
revocation of a link already handed out, and an audit trail.

Everything here is reproducible from a fresh clone with one command, and every
number comes from data in the repository that you can change to get your own.

```bash
git clone https://github.com/filelayer/filelayer.git
cd filelayer
node benchmark/run.mjs
```

It needs Node 22.18 or later, no account, no credential and no environment
variable. The network is used for npm and nothing else.

## The five implementations

| Implementation | Built with | Ran? |
|---|---|---|
| Filelayer | `@filelayer/core` 0.35.2 from npm, on PostgreSQL | Yes |
| Supabase | Supabase Storage and Postgres row-level security | Yes: real RLS policies on PostgreSQL (PGlite), with the platform schema emulated |
| Raw S3 | S3 or R2 presigned URLs and Postgres | Yes: against a local store that verifies SigV4 signatures |
| Convex | Convex and its R2 component | No, not executed and not compiled: it needs a live Convex deployment and an R2 bucket |
| Vercel Blob | Vercel Blob (a private store) and Postgres | No, not executed and not compiled: private Blob delivery has no local emulation |

**Who built them.** We did, in September 2026. Each alternative was written by
a separate AI agent, told to follow its platform's documented best practice and
to argue for that platform. Each one's directory has a `REPORT.md` with its
sources, what it could not implement, and a section called "Where this approach
is genuinely good". The brief they were built from and the prompt each agent
was given in September were not kept. `benchmark/BRIEF.md` says so, lists every
phrase of the brief that the agents quoted in their reports with its file and
line, and publishes the two prompts used since: the cold review of 3 November
and the revision round of 13 November. The Filelayer version is
the `examples/vault/server.ts` that ships in the npm package, and a second copy
of it wired as in production is counted beside it. The attack suite was written
by the same team that builds Filelayer. That is a conflict of interest, and the
section on the attacks says what we did about it.

**Each of the two alternatives that ran had one revision round.** The library was fixed each time
the attacks found a defect in it; the alternatives were frozen after one build.
So on 13 November each executed alternative got one round against the attacks,
at most 40 changed lines, done the way someone who knows the platform would do
it, with the diff published in `benchmark/revisions/`. Raw S3 changed 39 lines,
Supabase 8. Every result below is for the revised code. Convex and Vercel Blob
have never run, so their code was not changed; their counts assume they were
built the way their platforms document.

## Results

### Security-sensitive decisions

A decision here is a point where the developer can choose an option that leaks
or loses data and nothing reports it: no error, no failing test, no warning.
Counted as kinds, and as the places in the code where each must be got right.

| Implementation | Kinds | Places |
|---|---:|---:|
| Filelayer | 8 | 9 |
| Supabase | 26 | 64 |
| Raw S3 | 24 | 32 |
| Vercel Blob, not executed or compiled | 22 | 36 |
| Convex, not executed or compiled | 19 | 19 |

Over the two alternatives that ran, the average is about 3.1 times as many
kinds and 5.3 times as many places.

One rule for all five. A decision enforced in one helper is one place, however
many call sites use the helper. A decision is dropped when the platform's own
linter flags the wrong choice, or when the safe choice is the platform's default
and leaving it takes a deliberate act: then the wrong choice is not silent. That
rule removed two decisions from Filelayer (a private bucket and bucket
versioning, both defaults), the same defaults wherever an alternative counted
them, the two Supabase decisions its database linter flags, and a repeated
count wherever one helper carries the decision. Filelayer's count also gained three decisions its own
example gets wrong: the routes that create organizations and actors take no
identity, the new organization's owner is read from the request body, and the
request body has no size limit. Every change is recorded in `decisions.json`
on the decision itself, with its reason. One Filelayer decision is listed as
arguable; counting it gives Filelayer 9 kinds.

Two decisions that the first count in September held against Filelayer are no
longer in it, because the library fixed them in 0.3.0: the audit chain could
fork under concurrent writers, and a download cap was not charged on direct
reads. Both are listed in `decisions.json` under `removedSinceGate1`, with the
test that now holds each.

The Convex and Vercel Blob counts come from their authors' own lists only. The
attack suite added decisions to both executed alternatives that their authors
had missed, and it cannot do that for code that does not run, so those two
counts are probably low. That works against Filelayer and is left as it is.

### Lines the developer writes

Non-blank, non-comment application lines. Tests, tooling and the platform
emulation are not counted. The Filelayer library itself is not counted either:
it is vendor code, the way the Supabase or AWS SDK is.

| Implementation | Application lines | Infrastructure config | Relative |
|---|---:|---:|---:|
| Filelayer, the example | 133 | 0 | 1.0x |
| Filelayer, wired as in production | 161 | 50 | |
| Supabase | 569 | 0 | 4.3x |
| Raw S3 | 708 | 122 | 5.3x |
| Convex, not executed or compiled | 841 | 0 | |
| Vercel Blob, not executed or compiled | 884 | 21 | |

**Wired as in production, the two alternatives that ran take about 3.3 times
as many lines as Filelayer**: an average of 699.5 against 211, application and
infrastructure lines together. That is the number to compare if you are comparing deployments. The
example runs on an in-memory database and in-memory storage, and the
alternatives are counted with their production wiring, so the same example is
also counted wired as a deployment needs it: a pg pool, the schema applied once
under a lock, `S3Storage`, and the IAM and bucket policy it needs. It runs end
to end against PostgreSQL and an S3 store (`benchmark/production-wired/`).

Against the example as it ships, the average of the two is 638.5 application
lines against 133, about 4.8 times as many. Both figures leave out Convex and
Vercel Blob, which are listed for completeness: code that was never executed or
compiled may not even work.

**The library is not nothing.** Its code runs in your process and its schema in
your database, so it is counted too, apart from the lines you write:

| Implementation | Vendor lines in your process | Vendor lines in your database |
|---|---:|---:|
| Filelayer | 6,598 | 547 |
| Raw S3 | 42,010 (the AWS SDK) | 0 |
| Supabase, Convex, Vercel Blob | not measured | not measured |

Non-blank, non-comment lines, the same method as above; `count-vendor.mjs`
says what is included. Supabase's vendor code runs on its platform and its
schemas are emulated here, and the other two never ran, so a number for them
would be a guess.

Every inclusion and exclusion is a rule in `benchmark/loc.manifest.json`, and a
file that matches no rule fails the run.

### The 26 attacks

Written once, in `benchmark/adversarial/attacks.mjs`. They run over HTTP against
Filelayer and raw S3, and as direct calls into the application's functions for
Supabase, whose platform is emulated.

**The comparison uses only the 18 attacks that every executed implementation
can express.** None of the three was breached on them.

| Implementation | Defended | Partial | Breach |
|---|---:|---:|---:|
| Filelayer 0.35.2 | 18 of 18 | 0 | 0 |
| Raw S3 | 18 of 18 | 0 | 0 |
| Supabase, as built | 16 of 18 | 2 | 0 |
| Filelayer, earlier version (control) | 16 of 18 | 0 | 1 |

Before the revision round, neither raw S3 nor Supabase recorded a refused
cross-tenant read, or probes at documents that do not exist, in the
application's own audit trail. Nothing was disclosed, and gateway or load
balancer logs may have held them. A few lines closed it in both; the diffs are
in `benchmark/revisions/`.

Supabase's two partials are one design choice, labelled "as built": its share
gateway redirects to a signed URL valid for 30 seconds instead of streaming the
bytes. So a revoked link keeps working for up to 30 seconds, and the audit
records the issuing of a URL rather than a delivery. An Edge Function that
streams the bytes would close both, at the cost of egress through the function;
it was not built in the revision round, so these two results describe this
implementation, not Supabase. The second partial is attack E2 working as
defined: an implementation that redirects to a signed URL, rather than serving
the bytes, can only record that a URL was issued, never whether it was used, so
E2 scores any redirect to a signed URL as partial, whichever platform issues
it.

**The other 8 attacks are reported apart and never added into that
comparison.** Most test a feature only some implementations have, such as
per-file visibility inside a tenant, delegation or share listing; the rest
depend on whether the application serves the bytes itself. Filelayer defends
all 8. Raw S3 can express 4 of them and defends 3. On the fourth, HTML uploaded
and opened on the signed-in read path, its presigned URL asks S3 to serve the
file as an attachment, which real S3 does and the local store here does not
implement: it is reported as "pass, not executed", not as a pass. Supabase can
express none. "Cannot express" is never counted as a pass. One of the 8,
escalation through delegation, is attempted as a direct SQL insert of a child
grant, because the HTTP surface only creates read grants.

**Why a perfect score is not the headline.** A suite that the implementation it
was written alongside passes in full is exactly the suite a reader should
distrust. So it is also run against an earlier version of Filelayer's own
example, from before its delivery and authorization were rebuilt, on the same
library. That version is breached 3 times: a forged but well-formed caller id
treated as real, among the 18, and among the other 8, a revoked download
replayable from a cache and user-uploaded HTML rendered on the authenticated read
path. The suite finds real defects in Filelayer's own code, which is the best
evidence we have that it is not shaped around it. It is still our suite.
Independent attacks are welcome, as an issue or a pull request.

### From install to a stored file

From `npm install` to the first stored file, using the program printed in the
quickstart that ships in the package: 4 lines of application code, no step that
needs a person, and no account, credential or dashboard. On the machine that
generated these results it took 5.3 seconds; seconds depend on the machine and
the network.

## Where the alternatives are better

Each alternative's `REPORT.md` has this section in full. The short version:

- **Supabase fails closed, and its rules cannot be bypassed by new code.** No
  policy means no access, every rule is in one declarative file you can query
  and show a compliance auditor, and the policies apply to every path into the database,
  a `psql` session included. Filelayer is authorization middleware: it decides
  for calls made through it, and a direct `SELECT` against its tables is not
  checked by anything. If your team already runs on Supabase, it is one vendor
  instead of two.
- **Presigned URLs are the right answer when you do not need to take a link
  back.** Bytes never touch your server, so there is no body limit, no memory
  pressure and no bandwidth bill on your app tier. For a 5 GB file it is the only
  sane option. Filelayer's default serves bytes through your process, because
  that is how revocation works on the next request, and that means no CDN on the
  private path.
- **Vercel Blob's private store makes immediate revocation the default.** A
  private blob has no fetchable URL, so every byte goes through your code. Its
  credentials rotate on their own, and there is far less infrastructure to
  configure.
- **For a public, cacheable file, such as an avatar on a recipe site, a bucket
  and a CDN are the better tool.** Filelayer can serve public files, but its
  value is in the private ones.

## What this does not measure

- Load, or anyone's production. Filelayer has no known production deployment.
- How long each implementation took to build, or would take a person.
- Two of the five alternatives, Convex and Vercel Blob, which were neither
  executed nor compiled.
- Anything an independent security reviewer would: there has been no independent security
  review of Filelayer.

## Disagreeing with a number

Every number comes from data in `benchmark/`. Remove a row from
`decisions.json`, or change a rule in `loc.manifest.json`, run
`node benchmark/run.mjs` again and you have your own figure. If you think an
alternative was built badly, its directory says what it followed and where; an
issue that shows the better version is the most useful thing you can send us.

Filelayer is Apache-2.0. The quickstart is at
[filelayer.dev/quickstart](https://filelayer.dev/quickstart).
