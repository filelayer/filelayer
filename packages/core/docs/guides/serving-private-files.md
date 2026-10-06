# Should I redirect to a presigned URL or proxy private files myself?

The usual answer is redirect, and it is a good one. Your server authorizes the
request, mints a short-lived presigned URL, and sends a `302`. The bytes go
straight from the object store to the client, you pay no egress through your
own infrastructure, and the whole thing is about fifteen lines. For most private
files, most of the time, that is the right trade.

This guide is about the two things that answer leaves out, both of which bite
later and neither of which is about cost:

1. **A redirect's revocation window is the URL's remaining lifetime.** Not "a
   moment", not "the next request" — the full TTL, for anyone holding the URL,
   and there is no operation that shortens it. This is a property of signatures,
   not a gap in anybody's implementation.
2. **The moment you proxy instead, `Range` becomes your problem**, and getting
   it wrong breaks audio, video and PDFs in a way that reads as a corrupt file
   rather than as a server bug. The specific trap: **four of the five ranges
   that look like they deserve a `416` must be answered `200` instead.**

Everything below was measured. The script is
[beside this file](serving-private-files.proof.mjs): a real HTTP server and a
real Postgres, in-process, about five seconds.

---

## The property that decides it

A presigned URL is a credential, and the thing it is signed with is *time*. The
signature says "this request, to this object, until this instant". Nothing in
the object store consults your database when the request arrives — that is the
whole point of the design, and the whole reason it is fast and cheap.

So the question "how do I revoke a presigned URL?" has no answer at the URL
level. The answers that exist all work by changing something the signature
depends on, and each costs more than it first appears:

| Approach | Revokes | Collateral |
|---|---|---|
| Wait for expiry | eventually | everyone keeps access until then |
| Rotate the signing key | every URL, instantly | every URL, including ones you meant to keep |
| Move or rename the object | that object | breaks every other live URL for it |
| Delete the object | that object | you no longer have the file |

If that table is acceptable for your files, redirect. Shorten the TTL to the
smallest number your clients can live with and stop reading — the rest of this
page is about a cost you have decided not to pay.

It is *not* acceptable when removing someone's access is a feature you sell:
a shared document, a team member who left, a paid download, a subscription that
lapsed. In those cases the delay is not a performance characteristic, it is the
product failing to do the thing it promised.

### Measured

Bob is reading a file through the server, a range at a time, as any media player
does. Alice revokes his access while he is reading:

```
bob, bytes=0-4   -> 206 abcde
... alice revokes, with the read in progress
bob, bytes=5-9   -> 404 (nothing served)
```

One request. A presigned URL handed to bob instead would have kept serving until
it expired. That is the trade stated as a number: **the revocation window of a
presigned URL is its remaining TTL; the revocation window of a proxied read is
one request.**

Two details in that output worth taking:

- **`404`, not `403`.** Bob no longer has access, and telling him the file still
  exists is telling him something he is no longer entitled to know. A
  permissions system that answers `403` is a membership oracle.
- **The second range is refused, not the stream.** Revocation takes effect at
  the next *request*, not inside the response already in flight. A single
  enormous `200` that is already streaming will finish.

---

## If you proxy, `Range` is now yours

Redirecting delegated more than the bandwidth: the object store was also
answering `Range` requests, and it is very good at it. Proxy, and that falls to
you — including the parts that have nothing to do with your application.

This is not optional detail work. A `<video>` element issues a range request
before it will let the user scrub the timeline at all. A PDF reader asks for the
*last* few bytes first, because the cross-reference table lives at the end of the
document. Answer those wrongly and the file appears broken, not forbidden.

### What a client actually sends

Twenty-six bytes, one per letter, so a wrong offset reads as the wrong letters
instead of as plausible binary:

| Range header | status | Content-Range | body |
|---|---|---|---|
| *(none)* | 200 | — | `abcdefghijklmnopqrstuvwxyz` |
| `bytes=0-` | 206 | `bytes 0-25/26` | `abcdefghijklmnopqrstuvwxyz` |
| `bytes=0-4` | 206 | `bytes 0-4/26` | `abcde` |
| `bytes=5-9` | 206 | `bytes 5-9/26` | `fghij` |
| `bytes=-4` | 206 | `bytes 22-25/26` | `wxyz` |
| `bytes=20-` | 206 | `bytes 20-25/26` | `uvwxyz` |
| `bytes=20-999` | 206 | `bytes 20-25/26` | `uvwxyz` |

`Accept-Ranges: bytes` is on every one of them, including the `200`. That is
deliberate and it is the one easy to get backwards: a client reads
`Accept-Ranges` to decide whether it *may* seek, so advertising it only on
responses that are already ranged tells the client nothing it did not already
know, at the only moment it could not act on it.

`bytes=-4` is a suffix, not a negative offset: the last four bytes. `bytes=20-999`
is not an error — a last-position past the end is satisfiable, and the response
covers to the end.

### The five that look like `416` and are not

`416 Range Not Satisfiable` is the status everyone reaches for when a range
cannot be served as asked. It is almost always wrong, because RFC 9110 says an
**invalid** range must be *ignored* — answer `200` with the whole
representation — and reserves `416` for a range that parsed cleanly and cannot
be satisfied by *this particular object*.

Measured, same object:

| Range header | status | why |
|---|---|---|
| `bytes=9-4` | **200** | last-position before first-position: invalid, so ignored |
| `bytes=-0` | **200** | a suffix of zero asks for nothing |
| `bytes=abc` | **200** | unparseable |
| `items=0-4` | **200** | a unit that is not `bytes` |
| `bytes=0-4,10-14` | **200** | multiple ranges — see below |
| `bytes=99-120` | **416** | parsed cleanly, past the end of a 26-byte object, with `Content-Range: bytes */26` |

Only the last one is a `416`, and note what it carries: `bytes */26` tells the
client the actual size, which is the information it needs to ask a better
question. A `416` without it is a dead end.

**Multiple ranges deserve their own paragraph**, because the natural
implementation is a silent data-corruption bug. A server may answer all of them
as `multipart/byteranges`, or ignore the header and serve the whole object. What
it must not do is answer the *first* one under a `206`: the client asked two
questions, nothing in the status code says only one was answered, and it will
stitch the reply in at the wrong offset. Ignoring is the only one of the three
that cannot mislead, and it is what the table above does.

### The other thing that changes when you proxy

Your audit log gets less precise than it looks. The authorization decision — and
any download counter you charge — happens before a single byte moves, so a
transfer that dies halfway is recorded as an allowed read and still spends the
quota. "Every access on the record" means every authorization *decision*. If you
need "the bytes arrived", that is a second event, written at the end of the
stream, and nothing gives it to you for free.

---

## So: which one

Neither is the default. The question that decides it is not about cost:

> **Does withdrawing access have to take effect before the URL expires?**

- **No** → redirect. Short TTL, done, and you have not paid for bytes you do not
  need to touch.
- **Yes** → proxy, and own `Range` properly. The table above is the whole
  specification; it is about sixty lines of parser and it is the same sixty
  lines for everybody.

And a third answer worth naming, because it is often the real one: **both, per
file.** A public marketing asset and a customer's signed contract do not need
the same guarantee, and nothing stops one application from redirecting the first
and proxying the second. The decision belongs to the file, not to the codebase.

---

## With Filelayer

Proxying is the default, and the redirect path requires passing a verbatim
acknowledgement string, because the revocation window above is a property a
developer should have to type out before shipping.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
await fl.orgs.create('acme', { owner: 'ceo' });
const { id } = await fl.files.put(new TextEncoder().encode('CONTRACT'), {
  org: 'acme', owner: 'ceo', name: 'contract.pdf',
});

await fl.shares.create(id, { as: 'ceo', withUser: 'auditor' });

const asAuditor = await fl.files.stat(id, { as: 'auditor' });
assert.equal(asAuditor.name, 'contract.pdf');

await fl.shares.unshare(id, { as: 'ceo', user: 'auditor' });

// The next read is refused, and refused as `not_found`: whoever lost access is
// no longer entitled to know the file exists.
await fl.files.stat(id, { as: 'auditor' }); // throws 404
```

The `Range` handling is in the shipped routes: `deliveryHandler(fl)` is a
complete `node:http` listener that produces every row of both tables above.
What it does not do is multiple ranges in one request and `If-Range`; both are
in [LIMITATIONS](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
with the reasoning.

---

## Something wrong, or something missing?

If anything here does not reproduce, that is a real finding and we want it:
[open an issue](https://github.com/filelayer/filelayer/issues). Re-run the proof
before believing any of this.
