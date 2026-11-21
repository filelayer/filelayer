## Task: a change of requirements

`/work/app` holds a working implementation of the service in
`/work/contract/`, written by a colleague. The specification has not changed,
except for what follows, which is now part of it.

### Revocation records a reason

- `DELETE /orgs/{orgId}/shares/{shareId}` accepts an optional JSON body
  `{"reason": "<text>"}`. `reason` is a string of 1 to 200 characters. A body
  whose `reason` is present but is not such a string is 400, and the share is
  not revoked. A request without a body, or with a body without `reason`,
  revokes the share with no reason, as before.
- The `share.revoke` event that records an allowed revocation carries the
  reason that request gave in a new field, `revokeReason` (string, or null when
  it gave none). Every other event has `revokeReason` null.
- A share as listed gains two fields: `revokedAt` (date-time, or null while
  the share is live) and `revokeReason` (string or null).
- Revoking a share that is already revoked is still 204 and is still
  recorded, but the listing keeps the first `revokedAt` and the first
  `revokeReason`.
- A refused revocation stores nothing about the reason it carried.

Everything that worked before must keep working.
