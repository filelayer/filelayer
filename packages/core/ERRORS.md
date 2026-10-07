# Errors

Every code `@filelayer/core` can produce. **Generated** from
[`src/errors.ts`](src/errors.ts) by `tools/build-errors.mjs`; editing this
file by hand does nothing except fail the build.

The machine-readable form is [`errors.json`](errors.json), which ships in the
tarball and resolves as `@filelayer/core/errors.json`.

## Two things that are true of every row

**The status is a function of the code.** One code never means two statuses, so
a caller that branches on `code` never has to also branch on `status`. This is
enforced by the constructor, which does not accept a status at all.

**`reason` is not in this table and is never serialized.** A `FilelayerError`
carries an internal `reason` for your logs. It is deliberately absent from the
response body: `not_found` and "you are not a member of that org" are the same
answer to a caller who should not learn the difference.

## The caller can act on these

### `ambiguous_subject` — 400

A share named more than one kind of subject at once.

**Fix.** Pass exactly one of `withUser` or `withOrg`. `minRole` is only meaningful with `withOrg`.

### `bad_cursor` — 400

A listing cursor was not one this library issued.

**Fix.** Pass back the `cursor` from the previous page unchanged, or omit it to start again.

### `bad_request` — 400

A request body did not parse.

**Fix.** Send valid JSON, or a form body, and a matching `content-type`.

### `credential_in_query` — 400

A share-link request carried a credential in the query string.

**Fix.** Put the password in a POST body. Query strings reach access logs, proxy logs and browser history.

### `credential_in_query_string` — 400

An authorized-read request carried a credential in the query string.

**Fix.** Same as `credential_in_query`, on the `/f` route. The two codes differ only by which route refused.

### `invalid_argument` — 400

An argument was outside what the operation accepts.

**Fix.** `reason` names the argument. It is safe to log and is not shown to an untrusted caller.

### `link_is_read_only` — 400

A share link was asked to carry a capability beyond `read`.

**Fix.** Share with a named user or an org for anything other than reading. A link is a bearer token.

### `link_principal_cannot_list` — 400

A caller holding only a share link tried to list files.

**Fix.** A link grants one file. Listing needs an identity.

### `password_requires_link_subject` — 400

A password was set on a share that is not a link.

**Fix.** Only a link has somewhere to prompt. Drop the password, or make it a link.

### `password_required` — 401

This share link has a password and none, or a wrong one, was supplied.

**Fix.** Re-issue as a POST with `password` in the body. The response carries `WWW-Authenticate: FilelayerShare`.

### `forbidden` — 403

The caller has standing on the resource and may not do this particular thing. Narrower than it looks: it is used where a 404 would be less useful and leaks nothing, such as delegating more authority than you hold.

**Fix.** `reason` names the refusal for your logs.

### `not_found` — 404

The resource does not exist, or the caller may not know that it does. These are deliberately the same answer: a permissions system that distinguishes them is a membership oracle.

**Fix.** Nothing, from the caller. Check `reason` in your own logs to tell the two apart.

### `org_exists` — 409

An org with that external id already exists under a different owner.

**Fix.** Pick another id, or look the existing one up with `fl.ids.orgId()`.

### `retention_hold` — 409

A delete was refused because the file is under a retention hold.

**Fix.** Wait for the hold to lapse. It cannot be lifted through this API, which is the point of a hold.

### `upload_not_received` — 409

A direct upload was completed but the object is not in the store.

**Fix.** The client never finished the PUT, or sent it elsewhere. Reserve again.

### `upload_size_mismatch` — 409

The object that arrived is not the size the upload was authorized for.

**Fix.** Reserve again with the real size. The store should have refused this; if it did not, check that `content-length` is in the signed headers.

### `gone` — 410

The grant that would have allowed this has expired.

**Fix.** Ask the owner for a new link or a new grant.

### `upload_reservation_expired` — 410

The upload window closed before the bytes arrived.

**Fix.** Reserve again. A reservation is deliberately short.

### `payload_too_large` — 413

A request body exceeded the limit for that route.

**Fix.** Send less. For file bytes, use a direct upload rather than a body.

### `range_not_satisfiable` — 416

A `Range` header parsed cleanly and cannot be satisfied by this object. An INVALID range is not this: it is ignored, and the whole object is served under a 200.

**Fix.** The response carries `Content-Range: bytes */<size>`, which is the size you needed in order to ask a better question.

## These are about your configuration, not the caller

A 5xx here almost never means a failure. It means the application was configured in a way that cannot serve this request, and the caller has no way to fix it. `internal` is the one exception.

### `direct_upload_bad_max` — 500

`maxUploadBytes` was absent or not a positive integer.

**Fix.** Choose a ceiling. There is deliberately no default, because an exact pin to whatever the client asked for is not a bound.

### `direct_upload_bad_ttl` — 500

`ttlSeconds` for a direct upload was below 60.

**Fix.** Use at least 60. A shorter window fails real uploads on real networks.

### `direct_upload_not_acknowledged` — 500

Direct upload was configured without the verbatim acknowledgement string.

**Fix.** Pass `DIRECT_UPLOAD_ACKNOWLEDGEMENT`. Handing the data path to the object store is a property you give up, not a setting you tune.

### `internal` — 500

Something failed that is not one of the above. This is the only code here that means a defect rather than a decision.

**Fix.** Report it: https://github.com/filelayer/filelayer/issues

### `redirect_bad_ttl` — 500

`ttlSeconds` for redirect delivery was below 1.

**Fix.** Use at least 1. Values above the maximum are clamped rather than refused.

### `redirect_not_acknowledged` — 500

Redirect delivery was configured without the verbatim acknowledgement string.

**Fix.** Pass `REDIRECT_ACKNOWLEDGEMENT`. A redirect stays valid for its whole TTL after a grant is revoked.

### `storage_cannot_list` — 500

Orphan collection was asked of a storage adapter that cannot list objects.

**Fix.** Use an adapter that implements `list()`, or do not schedule `collectStorageOrphans()`.

### `direct_upload_not_enabled` — 501

Direct upload was requested on an instance that has not configured it.

**Fix.** Configure `directUpload`, or use `upload()`, which sends bytes through your server and works on every adapter.

### `direct_upload_unsupported` — 501

The configured storage adapter cannot sign an upload.

**Fix.** `reason` names the provider. `FsStorage` can mint a local upload token instead; `MemoryStorage` cannot sign at all.

---

29 codes. Generated for `0.19.1`.
