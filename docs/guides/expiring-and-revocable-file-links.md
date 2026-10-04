# How do I make a file link that expires — and that I can take back?

The usual answer is "generate a presigned URL with an expiry". That answer is
right about expiry and wrong about taking it back, and the difference only shows
up on the day you need it.

This guide is about the second half. It is written to be useful whether or not
you use Filelayer: the design and the SQL below are yours to copy, and the one
query that is genuinely hard to get right is given in full, along with the test
that proves the obvious version is broken.

---

## The short answer

**A presigned URL cannot be revoked individually.** Once it is out, you can wait
for it to expire, or you can do something with a blast radius much larger than
one link.

If "stop this link working, now" is a requirement — and for a share link sent to
a human it usually becomes one — then the URL has to point at **your** server,
and your server has to decide on every request. That is roughly forty lines of
code plus one query that is easy to write wrong.

---

## Why the usual answer does not do what people think

A presigned URL is a signature over a request, computed with your AWS
credentials. The object store validates the signature and the embedded expiry.
It does not call you, and it has no idea the link was forwarded to the wrong
person.

Which means there is no per-link off switch. The documented ways to kill one
early are:

| What you can do | What it also does |
|---|---|
| Delete the object | Kills the file, for everyone, permanently |
| Change the bucket policy to deny | Affects every caller the policy matches |
| Deactivate the signing credential | Invalidates **every URL that credential ever signed** |
| Add an `aws:signatureAge` condition | Expires links by age across the bucket; still not per-link |

AWS states it plainly: a presigned URL expires when the credential used to
create it is revoked, deleted or deactivated — which is the whole credential,
not the one link.

Two more things that surprise people, both worth knowing before you design
around presigned URLs:

- **The ceiling is 7 days** (`604800` seconds) under SigV4, and only with
  long-lived IAM user credentials.
- **With temporary credentials you get far less, silently.** Sign from a Lambda,
  an EC2 instance profile or any STS role and the URL dies when the *session*
  dies — commonly 1 to 12 hours — no matter what expiry you asked for. The
  request succeeds, the number you passed is ignored, and you find out from a
  user.

None of this makes presigned URLs bad. They are excellent at what they are: a
short-lived, fire-and-forget grant that costs your server nothing because the
bytes never touch it. If the link lives for ninety seconds and is used once,
stop reading and use one.

---

## The four options, and what each costs

**1. Short expiry and accept it.** Simplest. Correct whenever the link's natural
lifetime is minutes. "Revocation" becomes "wait".

**2. One credential per link.** Sign each URL with its own short-lived STS
session, then revoke that session to kill that link. It genuinely works, and it
costs you an IAM session per share, a way to map links to sessions, and a quota
you will eventually hit.

**3. Keep the object private and proxy the bytes.** The link points at your
server. You decide, then stream. Full control, full audit, and every byte goes
through your process — which is the real cost and the reason to think about it.

**4. Proxy the decision, redirect the bytes.** Your server decides, then issues a
presigned URL with a very short expiry and redirects. You get the decision point
and the CDN-ish economics, at the price of a window: a link revoked *now* still
works for whoever already holds an unexpired redirect. Bound that window by
clamping the expiry to seconds, and know that you have it.

Options 3 and 4 are the ones that give you "stop this link, now". The rest of
this guide builds 3, because 4 is 3 plus a redirect.

---

## The design

A link is a **row**, not a URL. The URL carries a secret that identifies the row;
everything that decides is in the row.

```sql
CREATE TABLE share_link (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id        uuid NOT NULL REFERENCES file(id),
    -- Store the HASH. The plaintext secret is returned to the caller once and
    -- never persisted: a leaked database should not be a leaked set of live
    -- links.
    secret_hash    bytea NOT NULL UNIQUE,
    expires_at     timestamptz,
    max_downloads  integer,
    download_count integer NOT NULL DEFAULT 0,
    revoked_at     timestamptz,
    created_by     uuid NOT NULL REFERENCES app_user(id),
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT downloads_within_cap
        CHECK (max_downloads IS NULL OR download_count <= max_downloads)
);

CREATE INDEX ON share_link (file_id) WHERE revoked_at IS NULL;
```

Minting a link is an insert. Revoking it is `UPDATE … SET revoked_at = now()`,
and it takes effect on the next request because the next request reads the row.
That is the entire mechanism, and it is why this works where a signature cannot:
**the authority is looked up, not carried.**

Three details that matter more than they look:

- **Hash the secret.** `sha256` is fine; this is a 32-byte random value, not a
  password, so a slow KDF buys nothing. Compare in constant time.
- **The secret goes in the path, never the query string.** Query strings end up
  in access logs, `Referer` headers and browser history.
- **Expiry and revocation are different things** and you want both. Expiry is a
  promise you made at creation time. Revocation is a decision you make later. A
  design with only expiry cannot express "I sent that to the wrong address."

---

## The one query that is hard

Serving a download has to check liveness and spend a download, and the obvious
way to write it is broken:

```js
// WRONG. Do not ship this.
const { rows } = await db.query('SELECT * FROM share_link WHERE secret_hash = $1', [h]);
const link = rows[0];
if (!link || link.revoked_at || link.expires_at < new Date()) return deny();
if (link.max_downloads !== null && link.download_count >= link.max_downloads) return deny();
await db.query('UPDATE share_link SET download_count = download_count + 1 WHERE id = $1', [link.id]);
```

Between the `SELECT` and the `UPDATE` there is a window, and two requests that
arrive inside it both read the same `download_count` and both decide they are
allowed.

This is not theoretical and it is not rare: it is what a busy link does the first
time somebody posts it somewhere. Measured against a real PostgreSQL, two
connections, a 50 ms window, a cap of one:

| | Result |
|---|---|
| The naive version, **without** the `CHECK` above | **both served**, counter ends at 2 |
| The naive version, **with** the `CHECK` | one served, the other gets SQLSTATE `23514` |

So the constraint is worth having — it converts a silent overshoot into a loud
error — but a 500 for the second visitor is not the answer either. The
constraint is a backstop, not the fix.

The fix is to make the check and the spend **one statement**, so the decision
happens under the row lock rather than before it:

```sql
-- Right. The reservation IS the write: there is no window to lose.
UPDATE share_link
   SET download_count = download_count + 1
 WHERE secret_hash = $1
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   AND (max_downloads IS NULL OR download_count < max_downloads)
RETURNING id, file_id, download_count;
```

No row returned means denied — and it does not tell you *why*, which is fine for
the response and a problem for your logs, so record the reason separately.

**Why this works**, because the mechanism matters if you are going to modify it:
on PostgreSQL's default `READ COMMITTED`, a second `UPDATE` arriving at a locked
row blocks, and when the lock is released it **re-evaluates its `WHERE` against
the updated row**. The `download_count < max_downloads` test is therefore made
against the value the first request already wrote, not against the one that was
there when the statement started. There is no window because there is no earlier
read to go stale.

Measured, same setup, with this statement instead:

| Concurrent requests | Cap | Served | Counter |
|---|---|---|---|
| 2 | 1 | 1 | 1 |
| 10 | 3 | 3 | 3 |
| 20 | 1 | 1 | 1 |
| 50 | 7 | 7 | 7 |

One note if you are not on the default isolation level: under `REPEATABLE READ`
the same statement does not block-and-recheck, it aborts the loser with SQLSTATE
`40001`. That is correct behaviour and your application has to retry it. Measured
too, and it is the kind of thing that works in development and surprises you in a
job that runs at `REPEATABLE READ`.

Every number above came out of
[`expiring-and-revocable-file-links.proof.mjs`](expiring-and-revocable-file-links.proof.mjs),
next to this file. It starts a real PostgreSQL as an ordinary user process, needs
nothing installed and no server running, and takes about twenty seconds:

```
node docs/guides/expiring-and-revocable-file-links.proof.mjs
```

Re-run it before believing any of this. A guide whose numbers you cannot
reproduce is an assertion in a confident voice.

Two notes if you grow into them:

- **If links can delegate** (a recipient mints a narrower link of their own), a
  download must spend the budget of the whole ancestor chain, or a parent with
  five downloads left can mint three children and sell fifteen. Lock the chain
  in a deterministic order — id order works — or two siblings redeemed at once
  will deadlock.
- **`FOR UPDATE` on a `SELECT` is the other correct answer**, and it is easier to
  read when the logic grows past what fits in one `UPDATE … WHERE`. The property
  you need is that nothing decides on a value it read before taking the lock.

---

## Serving the bytes

```js
app.get('/d/:secret', async (req, res) => {
  const h = sha256(req.params.secret);
  const { rows } = await db.query(CONSUME_SQL, [h]);   // the UPDATE above
  if (!rows[0]) return res.status(404).end();          // not 403 — see below

  const object = await storage.getStream(rows[0].file_id);
  res.writeHead(200, {
    'content-type': object.contentType,
    'content-disposition': `attachment; filename="${rfc5987(object.name)}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  object.body.pipe(res);
});
```

Four things in those headers are load-bearing, and all four are things people
leave out:

- **`attachment`, and `nosniff`.** If a user can upload HTML or SVG and you serve
  it inline from your own origin, you have stored XSS against your own domain,
  with your session cookies.
- **`no-store`.** A revoked link that a CDN or a browser still has cached is a
  revoked link that still works.
- **`no-referrer`.** Otherwise the secret in the path leaks to every site the
  downloaded page links to.
- **Escape the filename.** A CR or LF in a user-supplied name splits your
  response headers.

**Answer 404, not 403.** A 403 confirms the link exists, which turns a secret you
cannot guess into one you can probe. Say the same thing for "never existed",
"revoked", "expired" and "exhausted", and keep the real reason in your log where
it is useful and not disclosive.

---

## What this still does not give you

Being honest about the edges, because they are the next thing you will hit:

- **A download is counted when the response starts, not when it finishes.** A
  client that disconnects at 90% has spent a download. Counting on completion
  means holding the row lock for the length of the transfer, which is worse.
  Pick deliberately.
- **Range requests.** If the link is for video and the player seeks, a naive
  implementation charges a download per range request. Decide whether a "down
  load" means a request or an object.
- **The bytes go through your process.** That is the cost of option 3. For large
  files at volume, option 4 and a clamped redirect window is the trade.

---

## When you do not need any of this

If the link lives for seconds, is used once, and nobody will ever ask you to take
it back — use a presigned URL. It is less code, it costs your server nothing, and
this entire guide is overhead.

The moment somebody asks "can you kill that link?", you need a row.

---

## If you would rather not build it

[Filelayer](https://github.com/filelayer/filelayer) is this, packaged: grants as
rows, revocation on the next request, caps that hold under concurrency, the
header set above, and an audit trail that records the refusals as well as the
reads. It is Apache-2.0, it runs on your own Postgres and your own bucket, and
it is alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers including the ones sitting at zero.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
const bytes = new TextEncoder().encode('CONTRACT');
const { id: fileId } = await fl.files.put(bytes, { owner: 'alice', name: 'contract.pdf' });
-->

```ts
const share = await fl.shares.create(fileId, {
  as: 'alice', expiresIn: 3600, maxDownloads: 3,
});

// The link works...
await fl.shares.redeem(share.secret, {});

await fl.shares.revoke(share.grantId, { as: 'alice' });

// ...and the next request does not. No deletion, no key rotation, no waiting.
await assert.rejects(
  () => fl.shares.redeem(share.secret, {}),
  (e: { status?: number }) => e.status === 404,
);
```

That block is executed by `npm run check:docs` on every commit, which is why it
is the shape it is: if revocation stopped taking effect on the next request, this
page would fail the build rather than quietly become untrue.

Filelayer's own version of that statement is a `plpgsql` function rather than the
single `UPDATE` above, because a download there also has to spend the budget of
every ancestor grant. The property is the same and it is asserted on every
commit by `test/contention.test.ts`, against a real PostgreSQL with two backends,
including the control that shows the naive version overshooting.

---

## Related

- [Private file uploads](private-file-uploads.md) — the other half: a presigned
  PUT does not limit the size of what gets uploaded, and the policy that does.

---

## Sources

- [Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — AWS, on expiry and credential lifetime
- [Sharing objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) — AWS, the 7-day SigV4 ceiling
- [How to invalidate an S3 pre-signed URL](https://repost.aws/questions/QUIdRjOEc2TaiZ7om8s9IMKg/how-to-invalidate-a-s3-pre-signed-url) — AWS re:Post, on the absence of per-link revocation
- [The illustrated guide to S3 pre-signed URLs](https://fourtheorem.com/the-illustrated-guide-to-s3-pre-signed-urls/) — fourTheorem
- [Why do S3 pre-signed URLs expire after 12 hours](https://elasticscale.com/blog/why-do-s3-pre-signed-urls-expire-after-12-hours-despite-setting-a-longer-duration/) — elasticscale, on the temporary-credential ceiling
