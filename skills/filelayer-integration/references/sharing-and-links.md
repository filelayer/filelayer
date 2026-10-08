# Sharing, links, and taking access back

## Four kinds of share, and they are not interchangeable

All of them are `fl.shares.create(fileId, opts)`; what you pass decides which
one you get.

```ts
// A named user. No secret exists, so there is nothing to leak or forward.
await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

// Every member of an org. Resolved per request against membership: add or
// remove a member and their access changes on the next call, with no grant
// row touched and nothing fanned out.
await fl.shares.create(id, { as: 'alice', withOrg: 'acme' });
await fl.shares.create(id, { as: 'alice', withOrg: 'acme', minRole: 'admin' });

// A link, for somebody with no account. The secret is returned EXACTLY ONCE;
// only its SHA-256 is stored.
const link = await fl.shares.create(id, { as: 'alice', expiresIn: 86_400, maxDownloads: 3 });
link.url;       // hand this over now or it is gone
link.secret;    // the same, without the URL around it
```

`withOrg` can name a **different** org from the file's own — "the company that
posted this job may read this CV" — as long as both are in the same project.

## The mistake worth preventing

**`shares.create()` is not idempotent.** Every call inserts a grant row. A
double-clicked button makes two grants; a nightly re-sync makes one a night.

So a grant id is not a person's access:

```ts
await fl.shares.unshare(id, { as: 'alice', user: 'bob' });  // ALL of bob's live grants on this file
await fl.shares.revoke(grantId, { as: 'alice' });           // exactly one grant
```

Use `unshare` to remove a person. Use `revoke` for a link whose secret you
handed out and now want dead. Removing a person with `revoke` leaves whichever
other grants they accumulated, and the access survives in a way that looks
like a bug in the library.

There is no dedupe by design: two calls with different `expiresIn` are two
legitimately different windows, and the engine cannot tell those from a
double-click.

## Passwords, and why they only work on links

`password` is only meaningful on a link, because a link is the only path with
somewhere to prompt. On any other subject it is refused with
`password_requires_link_subject`.

The flow, which the shipped routes implement for you:

1. `GET /d/<secret>` on a password-protected link answers `401` with
   `WWW-Authenticate: FilelayerShare` and a body naming the retry.
2. The client re-issues as `POST /d/<secret>` with `{"password":"..."}` in the
   body, or form-encoded.
3. A password in the query string is refused with `400`, before any work and
   without spending a download. Query strings reach access logs, proxy logs and
   browser history.

## Expiry and caps

`expiresIn` is seconds from now. `maxDownloads` is a counter spent per
delivery, and the remaining count comes back in `x-downloads-remaining` on the
response, which is safe to show the recipient — they already hold the
credential it counts against.

Two edges worth telling the developer about:

- A **capped** grant drops byte ranges and serves the whole object with
  `Accept-Ranges: none`, because charging a seek against the cap would make
  `maxDownloads: 3` mean "three seeks".
- A **delegated** share can never exceed the authority it came from. Ask for a
  longer expiry than the parent grant has and you get the parent's, returned in
  the result rather than silently applied, so the clamp is visible.

## Revocation is immediate, and that is the whole product

On the proxied path, removing access takes effect on the caller's **next
request**. There is no TTL to wait out and nothing cached to expire.

That property has one exception and it is opt-in: **redirect delivery**. If the
application turns it on, the route answers with a `302` to a presigned URL, and
that URL stays valid for its whole TTL after the grant is revoked. It is off by
default, limited to anonymous grants unless widened, and requires passing a
verbatim acknowledgement string in the config. That string is the point: it is
a property you give up, not a setting you tune.

If the developer asks for a CDN in front of file delivery, this is the
conversation to have. The default path sets `Cache-Control: no-store`
precisely so that "revocation is immediate" is true at every intermediary and
not merely at the origin.

## What to tell them about the audit trail

Every authorization decision is recorded, including the denials — a stranger
probing ids leaves a trail. Two honest limits:

- A proxied delivery is audited **at the decision, not at the last byte**. A
  transfer that dies mid-stream is recorded as an allowed read and still spends
  the cap.
- The log grows without bound unless something calls `trimAuditChain()`.
