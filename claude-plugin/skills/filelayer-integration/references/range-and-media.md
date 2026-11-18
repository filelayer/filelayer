# Byte ranges, and serving media that has to play

Read this when the files are video, audio or PDFs — anything a client seeks
into rather than downloading whole. Getting it wrong does not look like a
permissions bug or a server bug. It looks like a corrupt file.

## Before any of this: is proxying the right answer here?

Everything below assumes the application serves the bytes. For media that is a
bigger commitment than for documents, and it is worth settling before writing
the route.

Proxying buys revocation on the next request and costs the CDN. Signed cookies
on a CDN — CloudFront signed cookies, Cloudflare signed URLs — buy the CDN and
cost a revocation window the length of the cookie's TTL.

The question that decides it is not technical: **how long may someone who was
just removed keep watching?** If a couple of minutes is acceptable, signed
cookies are better engineering for video and the developer should hear that.
If the answer is "the moment I click remove" — a compliance recording, a
terminated contractor, a paid course — then proxying is what they want, and
the bandwidth is the price of the property they asked for.

Volume matters too. Tens of concurrent viewers through a Node process is
unremarkable. Thousands is an infrastructure project, and it is the developer's
project, not the library's.

## Why this is suddenly your problem

When the application redirected to a presigned URL, the object store answered
range requests, and it is very good at them. Proxying moves that to your code.

It is not optional. A `<video>` element sends a range request before it will
let the user scrub at all. A PDF reader asks for the **last** few bytes first,
because the cross-reference table lives at the end of the file.

Filelayer's shipped routes do all of this. The reason to read it anyway is that
a developer may be replacing a hand-written route, and the hand-written one is
usually wrong in the same specific way.

## The mistake, and it is always the same one

`416 Range Not Satisfiable` is what people reach for when a range cannot be
served as asked. It is almost always the wrong answer.

RFC 9110 says an **invalid** range must be **ignored**: answer `200` with the
whole representation, as if the header had not been there. `416` is only for a
range that parsed cleanly and cannot be satisfied by this particular object.

Measured against a 26-byte object:

| Range header | status | why |
|---|---|---|
| `bytes=9-4` | **200** | last-position before first-position: the set is invalid, so it is ignored |
| `bytes=-0` | **200** | a suffix of zero asks for nothing |
| `bytes=abc` | **200** | unparseable |
| `items=0-4` | **200** | a unit that is not `bytes` |
| `bytes=0-4,10-14` | **200** | multiple ranges — see below |
| `bytes=99-120` | **416** | parsed cleanly, past the end, with `Content-Range: bytes */26` |

**Four of the five that look like a 416 are not one.** A hand-written parser
that treats "I could not use this" as 416 answers 416 to `bytes=9-4`, and that
is specifically what makes a video player give up and show a dead timeline.

The one real 416 carries `Content-Range: bytes */<size>`. Without it the client
has no way to ask a better question: it asked precisely because it did not know
the size.

**Multiple ranges deserve their own line.** Answering the *first* one under a
`206` is a silent data-corruption bug — the client asked two questions, nothing
in a 206 says only one was answered, so it stitches the reply in at the wrong
offset. Ignore the header and serve the whole object; it is the only one of the
three options that cannot mislead.

**`Accept-Ranges: bytes` goes on the plain `200` too**, not only on 206
responses. That header is how a client learns it is *allowed* to seek, and it
reads it before it has ever sent a range.

## Two Filelayer settings that interact badly with seeking

**`disposition: 'inline'` is required for playback.** The routes default to
`attachment`, which downloads instead of playing. Pass `disposition: 'inline'`
on the media route — and note that `auditIntegration()` checks for `attachment`
and will report a failure on an inline route. Mount a second route at the
default and point the harness there, or record why the exception is deliberate.

**Never put `maxDownloads` on a video.** A capped grant drops byte ranges and
serves the whole object with `Accept-Ranges: none`, because charging a seek
against the cap would make `maxDownloads: 3` mean "three seeks". The result is
a video that plays once from the start and cannot be scrubbed, which looks like
a player bug and is a configuration choice.

## Checking somebody's existing route in five minutes

```bash
curl -s -o /dev/null -D - -H 'Range: bytes=0-4'      "$URL"   # expect 206
curl -s -o /dev/null -D - -H 'Range: bytes=-4'       "$URL"   # expect 206, last 4 bytes
curl -s -o /dev/null -D - -H 'Range: bytes=9-4'      "$URL"   # expect 200, whole file
curl -s -o /dev/null -D - -H 'Range: bytes=0-4,9-12' "$URL"   # expect 200, whole file
curl -s -o /dev/null -D - -H 'Range: bytes=999999-'  "$URL"   # expect 416 + Content-Range
curl -s -o /dev/null -D -                            "$URL"   # expect Accept-Ranges: bytes
```

If the third or fourth comes back 416, that is the bug the player is reacting
to. If the last has no `Accept-Ranges`, the player will not even try to seek.

## One more, on the response status

Derive the status from whether the body is partial. Do not let a caller pass it
in. A partial body under a `200` is undetectable by every HTTP client on earth:
it stores, caches, hashes and hands on a truncated file with no error anywhere.
The status code is the only thing that makes it a range.
