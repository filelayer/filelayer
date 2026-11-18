# Mapping failures onto the application's own responses

## The shape

Everything throws `FilelayerError`, with:

- `status` — the HTTP status this code always means
- `code` — a stable, typed identifier. A union of the 29 codes the library can
  produce, not `string`, so a `switch` over it is exhaustive and `'not-found'`
  for `'not_found'` is a compile error rather than a branch that never runs.
- `reason` — the internal detail. **Never serialize this.**
- `headers` — response headers the error requires, set only where a status is
  defined in terms of one (a `416` carries `Content-Range: bytes */<size>`).

**The status is a function of the code.** One code never means two statuses, so
an application branching on `code` never has to also branch on `status`. The
constructor does not even accept a status; it reads it from the catalogue.

```ts
import { FilelayerError } from '@filelayer/core';

try {
  const file = await fl.files.get(id, { as: userId });
} catch (e) {
  if (e instanceof FilelayerError) {
    return new Response(JSON.stringify({ error: e.code }), {
      status: e.status,
      headers: { 'content-type': 'application/json', ...(e.headers ?? {}) },
    });
  }
  throw e;
}
```

## Do not leak `reason`

`code` is the safe field. `reason` carries the internal deny reason —
`no_membership`, `grant_revoked`, `bad_link_secret` — and it is recorded in the
audit log for an incident responder. In a response body it is an enumeration
oracle: a caller who can tell "no such file" from "not yours" can map which ids
are real.

This is the same reasoning behind the library answering **`not_found` where a
403 would have been more informative**. If the application's own error handler
turns that back into a 403, it has undone the property. `auditIntegration()`
checks for exactly this.

## The eight an integration meets first

| status | code | What happened |
|---|---|---|
| 404 | `not_found` | Does not exist, or the caller may not know that it does. Deliberately the same answer. |
| 401 | `password_required` | A share link has a password. Retry as `POST` with it in the body. |
| 403 | `forbidden` | The caller has standing and may not do this particular thing — delegating more authority than they hold, for instance. |
| 409 | `retention_hold` | A delete refused by a retention floor. |
| 410 | `gone` | The grant expired. |
| 400 | `credential_in_query` | A credential appeared in the query string. |
| 400 | `link_principal_cannot_list` | A share-link credential tried to list files. A link grants one file. |
| 413 | `payload_too_large` | A body exceeded the route's limit. |

## The full list is in the package, generated from the code

Do not reconstruct this table from memory and do not assume the eight above are
all of them — there are 29, and the published tables named eight of them until
`0.19.0` precisely because somebody wrote a list by hand.

- `node_modules/@filelayer/core/ERRORS.md` — every code with what to do about it
- `node_modules/@filelayer/core/errors.json` — the same, machine-readable, also
  resolvable as `@filelayer/core/errors.json`

Both are generated from `src/errors.ts` and a build gate fails if they drift.

## 5xx here usually means configuration, not failure

This is the distinction a bare status hides, and it is worth explaining to the
developer rather than letting them file a bug:

- `direct_upload_not_acknowledged`, `direct_upload_bad_max`,
  `direct_upload_bad_ttl`, `redirect_not_acknowledged`, `redirect_bad_ttl`,
  `storage_cannot_list` are all **500**, and every one of them means a setting
  is missing or out of range. The caller cannot fix any of them, which is why
  they are 5xx rather than 4xx.
- `internal` is the only code in the catalogue that means a defect in the
  library. If you see it, it is worth reporting.
- `direct_upload_not_enabled` and `direct_upload_unsupported` are **501**: the
  operation is not implemented on this configuration or this storage adapter.

## Checking a code at a boundary

When a code has arrived as a plain string — out of a log, across a queue,
through an HTTP body — `isErrorCode(s)` narrows it:

```ts
import { isErrorCode, ERROR_CODES } from '@filelayer/core';

if (isErrorCode(received)) {
  const { status, meaning, fix } = ERROR_CODES[received];
}
```
