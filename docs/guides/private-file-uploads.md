# How do I let users upload files privately?

The usual answer is "make the bucket private and hand the browser a presigned
URL". That answer is right, as far as it goes, and most tutorials get the part
they cover correct: the bucket is private, your AWS credentials never reach the
browser, the upload goes straight to S3.

What it leaves out is that **a presigned PUT URL is an unbounded write
primitive**. You mean to accept a 200 KB avatar; what you handed out accepts
three gigabytes. That is not a misconfiguration, it is what a presigned PUT is,
and the fix is a different kind of presigned request that almost none of those
tutorials mention.

This guide is written to be useful whether or not you use Filelayer. It is also
the guide where Filelayer is **not** the answer to the main question: we do not
do direct browser-to-storage uploads, deliberately, and the last section says
what to use instead.

---

## A private upload has three parts

Most answers cover the first and stop:

1. **Where the bytes go.** Private bucket, presigned request, credentials stay
   on your server. Well covered, and the tutorials are right.
2. **What bounds the upload.** Size, type, destination key. Barely covered, and
   the default answer has no bounds at all.
3. **Who may read it back.** The object key is not a secret. Barely covered.

Parts 2 and 3 are the rest of this page.

---

## The part that is usually missed

### A presigned PUT does not limit the size

The URL signs the method, the key and the expiry. **It does not constrain the
body.** A client handed a PUT URL for a 200 KB avatar can send three gigabytes
instead, and S3 accepts it — up to the 5 GB single-`PUT` ceiling.

The obvious defence does not work either: you can include `Content-Length` as a
signed header, and S3 still does not enforce it server-side for a `PUT`. The
client declares a length and then sends whatever it likes.

So what you have published is an authenticated, unmetered write into a bucket you
pay for. A hostile client does not need to break anything; it just uses the URL
you gave it, repeatedly, with large bodies. Your storage bill is the attack
surface.

### The fix is a presigned POST, which is a different thing

A presigned **POST** carries a *policy*: a signed document of conditions S3
evaluates before the object exists. The one that matters here is
`content-length-range`, and S3 enforces it at the door — an oversized upload is
rejected rather than discovered.

```js
// AWS SDK v3: @aws-sdk/s3-presigned-post
const { url, fields } = await createPresignedPost(s3, {
  Bucket: 'your-bucket',
  Key: `u/${userId}/${crypto.randomUUID()}`,
  Conditions: [
    ['content-length-range', 1, 2 * 1024 * 1024],   // 1 byte .. 2 MiB, enforced
    ['starts-with', '$Content-Type', 'image/'],
    ['eq', '$x-amz-meta-uploaded-by', String(userId)],
  ],
  Fields: { 'x-amz-meta-uploaded-by': String(userId) },
  Expires: 60,
});
```

The browser posts a `multipart/form-data` with `fields` plus the file. Anything
outside the policy never becomes an object.

Two conditions beyond the size are worth setting while you are there:

- **`starts-with` on the key**, so one user's URL cannot write into another
  user's prefix. If you sign an exact key this is already true; if you let the
  client choose any part of the key, it is not.
- **`starts-with` on `$Content-Type`**, which bounds what the *declared* type can
  be. Read the next section before trusting it.

The trade is that POST is more work on the client than `fetch(url, { method:
'PUT', body: file })`, which is most of why the tutorials teach PUT. It is the
right amount of work.

---

## Three more traps, in the order they bite

### 1. The declared content type is attacker-controlled

Whatever the client says in `Content-Type` is what S3 stores and what you will
later serve back. Accept an upload that declares `text/html`, serve it inline
from your own origin, and you have stored XSS against your own domain — with
your users' session cookies in scope.

Two defences, and you want both:

- **Decide the type from the bytes, not the declaration.** The first few bytes
  identify the common formats unambiguously: `89 50 4E 47 0D 0A 1A 0A` is PNG,
  `FF D8 FF` is JPEG, `25 50 44 46` is `%PDF`, `47 49 46 38` is GIF, and
  `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` is WebP. If you cannot identify it,
  `application/octet-stream` is the honest answer.
- **Serve it as an attachment with `X-Content-Type-Options: nosniff`.** This is
  the one that holds even when the sniffing is wrong, and it costs one header.
  If you must render images inline, serve user content from a *different origin*
  than your application.

A presigned POST cannot do the first for you: the policy sees the declared type,
not the bytes. Bounds at upload time, verification after.

### 2. The object key is not a secret

A long random key is not access control. Keys appear in logs, in
`Referer` headers, in backup tooling, in anything that has ever listed the
bucket, and in any URL a user pastes anywhere. If the only thing between a file
and the public is that the path is hard to guess, the file is public and you have
not noticed yet.

This is the reason private uploads need the download path designed too. Either
the bucket is private and every read is authorized by your server, or it is not
private. There is no third state, and "unguessable path on a public bucket" is
the second state wearing the first one's clothes.

### 3. The upload happens outside your transaction

The browser uploads to S3; your database knows nothing. Three ways that ends
badly:

- The client uploads and never calls your server. **An orphan object**, paid for
  monthly, referenced by nothing.
- You write the row first and the upload fails. **A row with no bytes**, and
  every read of it is a 500.
- Someone replays the callback. **A row that claims an upload nobody made.**

The shape that works is: a `pending` row before you issue the URL, a callback or
an S3 event that flips it to `ready`, and a sweeper that deletes `pending` rows
older than some grace period along with any object they point at. Decide
deliberately whether your callback is trusted — if the browser calls it, verify
against S3 with a `HEAD` rather than believing the size and type the client
reports.

**Confirm the object really is what you expect**, with that `HEAD`: size within
your bound, and the `ETag` if you care. It is one request, it catches the
difference between "the client said it uploaded" and "the bytes are there".

---

## If the files are small, consider not doing any of this

Direct-to-S3 exists to keep large uploads off your servers. If your files are
avatars and PDFs, uploading through your own process is simpler and strictly
safer: you see the bytes, so you can bound the size by counting as it arrives,
sniff the type from the content, and write the database row in the same request
that wrote the object. Every trap above disappears because the two things stop
being separate.

The cost is bandwidth and a request-sized chunk of memory or a stream. For files
measured in megabytes, that is a trade worth making. For files measured in
gigabytes, it is not.

---

## If you would rather not build it

Be clear about what this does and does not cover.

**Filelayer does not do direct browser-to-storage uploads.** Bytes go through
your server. If presigned POST uploads straight from the browser are what you
need, use the SDK directly with the policy above — that is the right tool and we
are not it.

What [Filelayer](https://github.com/filelayer/filelayer) does is everything after
the bytes land: ownership, org and role access, share links that expire and can
be revoked, lifecycle, and an audit trail that records refusals as well as reads.
It sniffs the content type from the magic bytes when you do not supply one, and
it owns the response headers on the byte path so the `nosniff` and `attachment`
above are not something you can forget.

<!-- doccheck-setup
import { Filelayer, sniffContentType } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
// The type comes from the bytes, not from what the client claimed.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
assert.equal(sniffContentType(png), 'image/png');

// Something we cannot identify is octet-stream, not the client's word for it.
assert.equal(sniffContentType(new TextEncoder().encode('<script>')), 'application/octet-stream');

const { id } = await fl.files.put(png, { owner: 'alice', name: 'avatar.png' });

// And the read path sets the headers for you.
const file = await fl.files.get(id, { as: 'alice' });
assert.equal(file.headers['x-content-type-options'], 'nosniff');
assert.match(file.headers['content-disposition']!, /^attachment/);
```

That block is executed by `npm run check:docs` on every commit. If the sniffing
or the headers changed, this page would fail the build rather than quietly become
untrue.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [Expiring and revocable file links](expiring-and-revocable-file-links.md) —
  the download half: why a presigned URL cannot be taken back, and the one query
  that is easy to write wrong.

---

## Sources

- [Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — AWS
- [Creating a POST policy](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html) — AWS, on `content-length-range` and the other conditions
- [Differences between PUT and POST S3 signed URLs](https://advancedweb.hu/differences-between-put-and-post-s3-signed-urls/) — Advanced Web Machinery, on PUT not constraining the body
- [Securing your Amazon AWS S3 presigned URLs](https://insecurity.blog/2021/03/06/securing-amazon-s3-presigned-urls/) — (in)security
- [S3 POST policy, the hidden S3 feature](https://dev.to/apptrail/s3-post-policy-the-hidden-s3-feature-you-havent-heard-of-k2g) — DEV
