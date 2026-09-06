# Security Policy

Filelayer is an authorization product. A bug in the authorization engine is not
a defect in a feature — it is a defect in the entire value proposition. We would
rather hear about one from you than from a customer.

## Status: developer preview

Read this before you decide how much to trust us.

- Filelayer is **pre-1.0 (`0.3.0`) and has never been run in production by
  anyone**, including us.
- The authorization core is covered by a property suite and an adversarial
  suite, both of which run in CI on every change.
- **The S3/R2 storage adapter has never been executed against live AWS or
  Cloudflare credentials.** It is exercised against a local, signature-verifying
  S3 implementation. That is not the same thing and we do not claim it is.
- The database schema may still change before 1.0.

The complete, current list of things we know are missing or weak is the
**Limitations** section of the [README](README.md). It is maintained as part of
the release and is deliberately not duplicated here — a second copy would be a
second thing to forget to update. If you are assessing risk, read that list
first: several items there are design trade-offs we made deliberately and would
not treat as vulnerabilities.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Report it privately, by either route:

- **GitHub Security Advisories** (preferred) —
  <https://github.com/filelayer/filelayer/security/advisories/new>. This creates
  a private thread with the maintainers and gives you a CVE path if one is
  warranted.
- **Email** — `security@filelayer.dev`.
  > **Not yet live.** `filelayer.dev` currently publishes no MX record, so mail
  > to this address does not arrive anywhere. Use the GitHub Security Advisory
  > route above, which is monitored. We would rather tell you an address does
  > not work than let a report vanish into it; this note is removed once the
  > mailbox is provisioned and tested end to end.

We do not currently run a bug bounty and have no budget for one. We will say so
plainly rather than imply a reward that does not exist.

### What to include

Whatever you have. A rough report beats no report. The ones we can act on
fastest contain:

1. The property you believe is broken — see the five security properties (P1–P5)
   in the [README](README.md), if one of them applies.
2. A minimal reproduction, ideally against `Filelayer.quickstart()`, which needs
   no infrastructure and runs in-process.
3. The version (`@filelayer/core` version or commit SHA) and Node version.
4. What an attacker gets: which tenant's data, under which identity, and what
   they had to know beforehand.

### What counts

In scope, and taken seriously:

- Any cross-tenant read, write or metadata leak.
- Any read of a private file by a principal without a live grant.
- Any way to make a **revoked or expired** grant serve bytes.
- Any way to exceed a download cap, an expiry, or a delegated grant's attenuated
  authority.
- Any way to write, forge, suppress or break the audit chain — or to make an
  allowed access **not** appear in it.
- Response-header, content-type or content-disposition handling that lets stored
  content execute in the serving origin.

Out of scope, because they are documented behaviour rather than defects:

- Anything already named in the README's Limitations section — including the
  bounded revocation window on opt-in redirect delivery, and the fact that org
  admins and owners can read `private` files.
- Denial of service through resource exhaustion. We do not ship rate limiting
  and say so; that is your ingress's job.
- Findings against the comparison implementations under `benchmark/`. Those are
  reference builds on Supabase, Convex, Vercel Blob and raw S3, written so the
  measurements in `ARCHITECTURE-PROGRESSIVE.md` can be reproduced and checked.
  They are in this repository on purpose, they are not shipped in any npm
  package, and nobody should deploy them. A defect in one of them is a finding
  about that measurement, not about `@filelayer/core` — interesting to us, and
  best filed as a public issue rather than through this process.

## Our disclosure policy

Coordinated disclosure. Concretely, what we commit to:

| Stage | Target |
|---|---|
| Acknowledge your report | 3 business days |
| Initial assessment, with a severity and whether we agree it is a vulnerability | 10 business days |
| Fix released for a confirmed critical or high finding | 30 days from acknowledgement |
| Public advisory | With the fix, or at 90 days from your report, whichever comes first |

If we are going to miss one of these, we will tell you before it passes rather
than after.

We will:

- keep your report private until an advisory is published;
- publish a GitHub Security Advisory for every confirmed vulnerability, even if
  the affected version had no known users — a quietly patched auth bug is how a
  project teaches people not to trust its changelog;
- record the finding in
  [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md), which already
  contains the security defects we found in ourselves;
- credit you by whatever name and link you ask for, or not at all if you prefer.

We ask that you give us the 90-day window before disclosing publicly, and that
you do not access, modify or retain data belonging to anyone else while
investigating. If you disclose earlier because we went silent on you, that is a
failure on our side, and we will say so in the advisory.

## Supported versions

Pre-1.0, only the latest `0.x` release receives fixes. There is no long-term
support branch and no backporting. See
[Versioning](README.md#versioning) in the README.

| Version | Supported |
|---|---|
| `0.3.x` | Yes |
| `< 0.3` | No |
