# One file feature, built five ways

A B2B document workspace, built five times: once with Filelayer and four times
the way each platform's own documentation recommends. Then the same scripts
count what each one asks the developer to write and to get right, and the same
27 attacks are run against every version that can run.

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
| Convex | Convex and its R2 component | No: it needs a live Convex deployment and an R2 bucket |
| Vercel Blob | Vercel Blob (a private store) and Postgres | No: private Blob delivery has no local emulation |

**Who built them.** We did, in September 2026. Each alternative was written by
a separate AI agent, told to follow its platform's documented best practice and
to argue for that platform. Each one's directory has a `REPORT.md` with its
sources, what it could not implement, and a section called "Where this approach
is genuinely good". The Filelayer version is the `examples/vault/server.ts` that
ships in the npm package. The attack suite was written by the same team that
builds Filelayer. That is a conflict of interest, and the section on the
attacks says what we did about it.

## Results

### Lines the developer writes

Non-blank, non-comment application lines. Tests, tooling and the platform
emulation are not counted. The Filelayer library itself is not counted either:
it is vendor code, the way the Supabase or AWS SDK is.

| Implementation | Application lines | Infrastructure config | Relative |
|---|---:|---:|---:|
| Filelayer | 133 | 0 | 1.0x |
| Supabase | 564 | 0 | 4.2x |
| Raw S3 | 700 | 122 | 5.3x |
| Convex | 841 | 0 | 6.3x |
| Vercel Blob | 884 | 21 | 6.6x |

Every inclusion and exclusion is a rule in `benchmark/loc.manifest.json`, and a
file that matches no rule fails the run.

### Security-sensitive decisions

A decision here is a point where the developer can choose an option that leaks
or loses data and nothing reports it: no error, no failing test, no warning.
Counted as kinds, and as the places in the code where each must be got right.

| Implementation | Kinds | Places |
|---|---:|---:|
| Filelayer | 7 | 7 |
| Supabase | 29 | 79 |
| Raw S3 | 26 | 46 |
| Vercel Blob | 22 | 61 |
| Convex | 20 | 43 |

Median reduction against Filelayer: 3.4x on kinds, 7.6x on places. One
Filelayer decision is listed as arguable; counting it gives 8 kinds and a
median of 3.0x and 6.7x.

Two decisions that the first count in September held against Filelayer are no
longer in it, because the library fixed them in 0.3.0: the audit chain could
fork under concurrent writers, and a download cap was not charged on direct
reads. Both are listed in `decisions.json` under `removedSinceGate1`, with the
test that now holds each.

The Convex and Vercel Blob counts come from their authors' own lists only. The
attack suite added decisions to both executed alternatives that their authors
had missed, and it cannot do that for code that does not run, so those two
counts are probably low. That works against Filelayer and is left as it is.

### The 27 attacks

Written once, in `benchmark/adversarial/attacks.mjs`, and run over HTTP against
every implementation that can run.

| Implementation | Defended | Partial | Breach | Cannot express the attack |
|---|---:|---:|---:|---:|
| Filelayer 0.35.2 | 27 | 0 | 0 | 0 |
| Supabase | 15 | 2 | 2 | 8 |
| Raw S3 | 19 | 1 | 2 | 5 |
| Filelayer, earlier version (control) | 20 | 2 | 3 | 2 |

"Cannot express the attack" is never counted as a pass. It means, for example,
that the implementation hands out a URL and the object store serves the bytes,
so an attack on the application's response headers has nothing to hit.

Both executed alternatives were breached on the same two attacks: probing for
documents that do not exist left no audit record, and a cross-tenant access
attempt that was refused left no record anywhere. Supabase's revocation is
partial: the gateway refuses at once, but a signed URL already issued stays
valid for 30 seconds.

**Why a perfect score is not the headline.** A suite that the implementation it
was written alongside passes 27 out of 27 is exactly the suite a reader should
distrust. So the suite is also run against an earlier version of Filelayer's own
example, from before its delivery and authorization were rebuilt, on the same
library. That version is breached 3 times: a revoked download replayable from a
cache, a forged but well-formed caller id treated as real, and user-uploaded HTML
rendered on the authenticated read path. The suite finds real defects in
Filelayer's own code, which is the best evidence we have that it is not shaped
around it. It is still our suite. Independent attacks are welcome, as an issue
or a pull request.

### From install to a stored file

From `npm install` to the first stored file, using the program printed in the
quickstart that ships in the package: 4 lines of application code, no step that
needs a person, and no account, credential or dashboard. On the machine that
generated these results it took 5.4 seconds; seconds depend on the machine and
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
- Two of the five alternatives, which did not run.
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
