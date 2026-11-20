# SOC 2 and file access: what to show a compliance auditor


A SOC 2 report does not certify a library, and nothing on this page makes an
application compliant. Using Filelayer does not make your application SOC 2
compliant, and Filelayer is not SOC 2 compliant itself: it is a library you run,
not a service with a report. What it can do is produce evidence, and that is
what this page is about: which questions about file access a compliance auditor asks, and
which records you can hand over in answer.

The questions come from the AICPA Trust Services Criteria. The criteria are
fixed; the controls that meet them are written by each organization, and the
compliance auditor tests how those controls are designed and whether they operate. So the
mapping below is from a criterion to the evidence a control of yours can point
at. It is not a list of controls you get for free.

---

## The short answer

| Criterion, in plain words | What the compliance auditor asks for | What Filelayer records |
|---|---|---|
| **CC6.1** Access to data is restricted by logical access security | Show that a user can reach only the files they are allowed to | One authorization function decides every read; a refused read is a `404` and an audit event with its reason |
| **CC6.2** Users are registered and authorized before they get access | Show who was given access, by whom, and when | `member.add` and `grant.create` events, with the person who acted and, for a role change, `fromRole` and `toRole` |
| **CC6.3** Access is changed and removed based on documented requests | Show that removed access is actually gone | `member.remove` and `grant.revoke` events, and the next read by that person refused with `grant_revoked` |
| **CC7.2** The system is monitored for anomalies | Show refused attempts, not only successful ones | Every denial is an event: `no_membership`, `insufficient_role`, `grant_revoked`, and others |
| Evidence integrity, asked under several criteria | Show that the log was not edited | A hash chain per organization, and `verifyAudit()` that replays it |

---

## Access is decided in one place, and refusals are recorded

The usual answer to "how do you restrict access to customer files?" is a list
of route handlers, each with its own check. A compliance auditor has to take the list on
trust, because a route that forgot its check looks exactly like one that did
not need it.

Filelayer answers every access question with one function, and writes the
decision to the audit trail in the same transaction as the decision. That
includes the refusals:

```ts
import { Filelayer } from '@filelayer/core';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });

await fl.orgs.create('acme', { owner: 'alice' });
await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
await fl.orgs.create('globex', { owner: 'eve' });
const { id } = await fl.files.put(new TextEncoder().encode('payroll'), {
  org: 'acme', owner: 'alice', name: 'payroll.csv',
});

await fl.files.get(id, { as: 'bob' }).catch((e) => e.status);   // 404: private, and bob is only a member
await fl.files.get(id, { as: 'eve' }).catch((e) => e.status);   // 404: another tenant
```

The audit trail for `acme` then reads, one line per decision (as printed by
[`soc2-file-access-evidence.proof.mjs`](soc2-file-access-evidence.proof.mjs),
which runs this page's code):

```text
alice member.bootstrap allow @acme
alice member.add allow @acme
alice file.create allow payroll.csv @acme
bob file.read deny:insufficient_role payroll.csv @acme
eve file.read deny:no_membership payroll.csv @acme
```

The caller gets a `404` in both refusals, so a stranger cannot learn that the
file exists. The reason is in the trail, where the compliance auditor reads it.

---

## Granting and removing access leaves a record of both

CC6.2 and CC6.3 are about the lifecycle of access: who was given it, on what
authority, and whether it was taken away when it should have been. The evidence
a compliance auditor samples is usually a request in a ticket and the change it caused.
The trail gives you the second half, with the person who made the change:

<!-- doccheck-setup
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
await fl.orgs.create('acme', { owner: 'alice' });
await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
const { id } = await fl.files.put(new TextEncoder().encode('payroll'), {
  org: 'acme', owner: 'alice', name: 'payroll.csv',
});
-->

```ts
await fl.shares.create(id, { as: 'alice', withUser: 'bob', expiresIn: 3600 });
await fl.files.get(id, { as: 'bob' });                            // allowed, while the grant lives
await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
await fl.files.get(id, { as: 'bob' }).catch((e) => e.status);    // 404, on the next request
await fl.orgs.removeMember('acme', 'bob', { as: 'alice' });
```

```text
alice file.share allow payroll.csv @acme
alice grant.create allow payroll.csv @acme
bob file.read allow payroll.csv @acme
alice file.share allow payroll.csv @acme
alice file.share allow payroll.csv @acme
alice grant.revoke allow payroll.csv @acme
bob file.read deny:grant_revoked payroll.csv @acme
alice member.remove allow @acme
```

`file.share` is the check that alice may share the file, made on every sharing
call; `grant.create` and `grant.revoke` are the changes themselves. The last two
lines matter most to a CC6.3 test. The removal is recorded, and the
first attempt after it is recorded as refused, with the reason. A membership
event also carries `fromRole`, `toRole` and the person changed in its `context`,
so a role change can be sampled without a second system.

Grants can carry an expiry, and a link can carry a download cap. Both are
enforced on every request, so an access review can rely on an expired grant
being inert rather than on someone remembering to remove it.

---

## Showing that the record was not edited

A compliance auditor who receives an export of a log table will ask how you know nobody
changed it. A table that anyone with database access can `UPDATE` has no
answer. Filelayer chains each event to the previous one by hash, per
organization, and `verifyAudit()` replays the chain:

```ts
const result = await fl.orgs.verifyAudit('acme', { as: 'alice' });
// { valid: true, attestedGaps: 0, trims: [], seals: [], ... }
```

An edited, inserted or reordered event breaks the replay. Removal of the most
recent events is a different case, and it is the one limit to state in your
control description: see
[How do I prove who accessed a file?](tamper-evident-file-audit.md) for what
the chain detects, what seals add, and what neither can.

Reading the trail is itself a decision and is itself recorded (`audit.read`).
Only an organization's admins and owners can read it.

---

## Retention, and erasure inside a retained log

A retention period is a control you write; the trail has to be able to keep to
it. `runMaintenance()` runs `audit_trim` for events past your retention period,
and a trim is recorded in the chain, so `verifyAudit()` reports it rather than
reporting a break. Erasing one person's events, when a privacy request requires
it, leaves an attested gap that verification counts: see
[How do I delete a user's data when my audit log is append-only?](erasing-a-user-with-an-append-only-audit-log.md).

---

## Checking your own integration, not ours

Evidence from a library's test suite says the library works. A compliance auditor tests
your system. `auditIntegration()` takes callbacks written against your own
routes and checks, against your running application, that an owner can read
their file, that a stranger is refused with a `404`, that an anonymous caller is
refused, and that an identity your application has never seen is refused rather
than treated as anonymous. Its report is something you can keep with your
control evidence.

---

## What this does not give you

- **Compliance.** Neither Filelayer nor an application that uses it is SOC 2
  compliant because of it. Compliance is the opinion a compliance auditor gives about your
  controls, across far more than file access.
- **A record of access that bypasses the library.** Filelayer decides for calls
  made through it. A direct `SELECT` against its tables, or a read straight from
  the bucket, is checked by nothing and recorded by nothing. Your database and
  bucket access controls are separate controls, and your bucket must be
  private.
- **Authentication.** Filelayer is told who the caller is. Whether that is true
  is your identity provider's control.
- **An independent review.** Nobody outside the project has reviewed
  Filelayer's authorization engine or its audit chain. The trust page says so.

---

## Related

- [How do I prove who accessed a file?](tamper-evident-file-audit.md): the hash
  chain, its limits, and retention
- [How do I make a file link that expires, and that I can take back?](expiring-and-revocable-file-links.md)
- [How do I do multi-tenant file access control?](multi-tenant-file-access.md)
