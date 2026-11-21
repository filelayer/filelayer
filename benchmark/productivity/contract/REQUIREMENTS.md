# Requirements: the document workspace

This is the specification every run implements. `openapi.yaml` in this folder
gives the routes, bodies and status codes; this file gives the rules those
routes must keep. Both are part of the contract. Where they disagree, this
file wins.

## What you are building

An HTTP service for a B2B document workspace. Companies (organizations) store
private documents. Their members have roles. A member can hand a document to
someone outside with a share link that expires, may require a password and may
allow only a number of downloads, and can revoke it at any moment. Everything
that happens, and everything that is refused, is in an audit trail the
organization's administrators can read.

## How it runs

- Node.js 22 or later. `npm install` then `npm start` in the project folder
  must start the server. Any framework and any libraries are allowed unless
  the instruction for your run says otherwise.
- It reads its configuration from the environment, and nothing else:

  | Variable | Meaning |
  |---|---|
  | `PORT` | The port to listen on, on 127.0.0.1. |
  | `DATABASE_URL` | A PostgreSQL connection string. The database is empty on the first start. |
  | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | An S3-compatible object store. The bucket exists and is private. Use path-style addressing. |
  | `BASE_URL` | The public origin of the service, such as `http://127.0.0.1:3000`. Share URLs start with it. |
  | `ADMIN_TOKEN` | The operator's secret for `GET /admin/audit`. |

- On start it creates whatever it needs in the database and is ready when
  `GET /health` answers 200. Starting it twice against the same database must
  work.
- Document bytes are stored in the object store, not in the database.

## Identity

- A user registers with `POST /users` and gets an id.
- Every other request except `GET /s/{token}`, `GET /health` and
  `GET /admin/audit` carries the caller's user id in `X-User-Id`.
  Authentication is out of scope: trust the header, as if a gateway had set it.
- No `X-User-Id` at all is 401.
- `POST /orgs` with an id that is not registered is 401.
- Under `/orgs/{orgId}/...`, an id that is not registered is answered exactly
  like a registered user who is not a member: 404. The two must not be
  distinguishable.

## Roles

Four roles, from most to least: `owner`, `admin`, `member`, `viewer`.

| Can | owner | admin | member | viewer |
|---|:-:|:-:|:-:|:-:|
| List and download documents, list members | yes | yes | yes | yes |
| Upload documents | yes | yes | yes | no |
| Create share links, list a document's shares | yes | yes | yes | no |
| Revoke a share link | any | any | the ones they created | no |
| Delete a document | any | any | the ones they uploaded | no |
| Read the org's audit trail | yes | yes | no | no |
| Add a member or change a role | any role | to `viewer`, `member` or `admin`, and never on an owner | no | no |
| Remove a member | anyone | anyone who is not an owner | no | no |

- The creator of an org is its owner.
- `PUT /orgs/{orgId}/members/{userId}` adds the user if they are not a member
  yet and sets their role otherwise. The target must be a registered user.
- An org always has at least one owner. A change or removal that would leave
  none is 409.
- A refused change by a member of the org is 403. Anything by someone who is
  not a member is 404.

## Documents

- Every document belongs to one org and is visible to that org's members and
  to nobody else.
- A document id that does not exist, a document in another org, and a
  document the caller cannot see all get the same answer: 404, with the same
  body. Nothing in the response may tell them apart.
- Deleting a document makes its bytes unreachable and its share links stop
  working at once.

## Delivery

Both download routes (`GET /orgs/{orgId}/documents/{documentId}` and
`GET /s/{token}`) serve the bytes themselves, and every successful response
carries:

- `Content-Type`: the type given at upload;
- `Content-Disposition: attachment`, with the document's name encoded so that
  no name, whatever characters it holds, can change the response's headers;
- `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, no-store`, so that a revoked link cannot be
  replayed from a cache.

The browser must never render an uploaded document as a page of this service.

## Share links

- A link is `${BASE_URL}/s/<token>`. The token is unguessable (at least 128
  bits of randomness) and is returned only once, in the response that creates
  it. Listing shares never returns a token, a URL or a password.
- `expiresInSeconds` sets when it stops working. After that it answers 404.
- With a `password`, a request without `X-Share-Password` or with the wrong
  one is 401 and consumes nothing. Store passwords so that a database reader
  cannot recover them.
- With `maxDownloads`, at most that many downloads succeed, even when many
  requests arrive at the same instant. Only a download that serves the bytes
  counts.
- Revoking takes effect for the very next request, for links already handed
  out too.
- An unknown, revoked, expired or exhausted token, or one whose document was
  deleted, is 404 with one and the same body.

## Audit trail

- Every request to the routes listed in `AuditEvent.action` that is decided,
  allowed or denied, is recorded as one event, with `actorId` as presented
  (or null for an anonymous share download), `orgId`, `documentId` and
  `shareId` where they apply, and a `reason` on every denial.
- Denials are recorded too, including:
  - a non-member's or an unregistered id's request against an org's documents;
  - a request for a document id that does not exist;
  - a share download with an unknown, revoked, expired or exhausted token, or a
    wrong password.
  Where an event cannot be attributed to an org without revealing something
  the caller could not otherwise learn, record it with `orgId` null.
- `GET /orgs/{orgId}/audit` returns the events of that org only, to its admins
  and owners. Reading it is itself recorded.
- `GET /admin/audit` returns every event, in every org and with none, to the
  holder of `ADMIN_TOKEN`.
- A share download is recorded when the bytes are served, as `share.download`.
- Events cannot be changed or deleted through the API.

## Validation and errors

- A body that does not match the schema is 400. Unknown fields are ignored.
- Every error response is JSON, `{"error": "<code>"}`.
- An uploaded document of more than 10 MiB is 413.
- No request may make the server answer 5xx, whatever it contains.
