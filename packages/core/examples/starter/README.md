# Starter

A deployable application, against a Postgres you own and bytes that survive a
restart. The other examples show what the API does; this one shows the parts
between `npm install` and something you could put behind a load balancer.

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/mydb
node --experimental-strip-types server.ts
```

That is the whole setup. The schema applies itself on first boot, bytes go to
`./filelayer-data`, and there is no bucket and no IAM user involved.

Then, in another terminal:

```bash
node verify.mjs
```

Twenty checks over HTTP: upload, an owner reading their own file, a stranger
refused, a share link with a download cap, revocation taking effect on the next
request, the audit log with the refusals in it, and the four things an
adversarial sweep broke on 3 October 2026 -- a percent-escaped tenant name
meaning one tenant rather than two, a malformed escape answering 400, an upload
over the ceiling answering 413, and two route shapes that used to reach a
handler with the wrong arity.

## What it does

| | |
|---|---|
| `POST /orgs/:org` | create a tenant, with you as its owner |
| `POST /files?org=&name=` | upload, owned by you |
| `GET /files/:id` | read it back, as you |
| `POST /files/:id/share` | a link that expires in an hour and allows three downloads |
| `DELETE /shares/:grantId` | revoke it; the next request fails |
| `GET /orgs/:org/audit` | the access log, denials included |
| `GET /d/:secret` | the share route, mounted from the library |
| `GET /public/:id` | published files, served as an anonymous caller |

Identity comes from an `X-User` header so that `curl` is enough to try it. In a
real application that line reads your session.

Uploads are capped at `MAX_UPLOAD_BYTES` (25 MB by default) and the cap is
counted as the body arrives, because `content-length` is a suggestion and a
chunked upload has none. Filelayer imposes no size of its own, which means your
application has to.

## The four things that are actually hard

Everything else in `server.ts` is routing you would write anyway. These four are
why the file exists.

**Configuration.** Filelayer reads no environment variable. Every one in
`.env.example` is read by `server.ts` and handed to a constructor, which saves
you looking for a config reference that does not exist.

**Applying the schema.** `schema.sql` is not idempotent and there is no migrate
command, so `applySchemaIfAbsent()` counts how many of Filelayer's nine tables
exist and applies the schema only if none do, under an advisory lock. Without the
lock, two servers booting together both find nothing, both apply, and one
crashes: a failure that never happens on a laptop and always happens in a
deployment. It counts nine rather than looking for one because the first version
asked for `project`, and `project` is a table name your application may well
already have -- point that version at the database you already use and it printed
"already applied", bound the port, and returned 500 from every route. A partial
match now stops the boot and says which tables it found.

**Choosing storage.** `FsStorage` by default: a real directory, no bucket, bytes
that survive a restart. It is one process on one disk, with no locking between
writers and no `presignGet`, so redirect delivery is unavailable. Set
`S3_ENDPOINT` and the other three `S3_*` variables to move to a bucket; nothing
else in the file changes.

**Creating a tenant.** `files.put({ org: 'acme' })` creates `acme` if it is
missing and joins you as a **member**. A member cannot read the audit log or set
roles, and gets the same `404` a stranger gets. `POST /orgs/:org` calls
`fl.orgs.create(org, { owner })`, which is the call that makes you its owner. The
verify script does that first, deliberately, because doing it the other way round
is the mistake this example exists to stop you making.
