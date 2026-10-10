# Uploading straight to the bucket

## First: do they need it?

Direct upload exists so that large files do not travel through the
application's process. That is the whole benefit and it is a real one above a
few tens of megabytes.

Below that, uploading **through** the server is simpler and strictly safer:
you see the bytes, so you can bound the size by counting as it arrives, sniff
the real content type from the content, and write the database row in the same
request that wrote the object. Every trap on this page disappears because the
two things stop being separate.

If the files are avatars and PDFs, say that and use `fl.files.put()`. Recommend
direct upload when the files are measured in hundreds of megabytes or
gigabytes.

## The thing nobody writes down

A presigned PUT URL signs the method, the key and the expiry. **It does not
constrain the body.** A URL minted for a 200 KB avatar accepts three gigabytes,
up to S3's 5 GB single-PUT ceiling. That is not a misconfiguration, it is what
a presigned PUT is, and passing a length to an SDK's presign helper does not
fix it: if `content-length` is not in `X-Amz-SignedHeaders`, the signature does
not cover it.

Filelayer's `createUpload()` signs `content-length` and `content-type` **into**
the presigned PUT, so the object store rejects a body of the wrong size or type
before accepting it. On Cloudflare R2 this is the only way to bound the body at
all, because R2 does not implement presigned POST.

## The shape

Three steps, and the third one is the one to be careful about.

```ts
// 1. Authorize, reserve, and mint a narrow credential. `maxUploadBytes` is
//    yours to choose and there is deliberately no default: an exact pin to
//    whatever the client asked for is not a bound.
const { file, upload } = await fl.createUpload(principal, orgId, {
  name: 'recording.mp4',
  contentType: 'video/mp4',
  size: declaredSize,          // REQUIRED and exact; the store enforces it
});
// -> file.id, and upload.url / upload.method / upload.headers / upload.via

// 2. The browser PUTs straight to the store, sending those headers verbatim.
//    This is where the progress bar and the multi-file UI stay.

// 3. The client tells your server it finished, and only now does the file
//    become readable. completeUpload() asks the STORE what actually arrived.
const ready = await fl.completeUpload(principal, file.id);
```

Until step 3 succeeds the row is `pending` and **refuses `read`**, so a file
whose bytes never arrived is unreadable rather than broken.

`completeUpload()` is where the honesty is: it does a `HEAD` against the store
rather than believing what the client reported. A size that does not match the
one that was authorized is `upload_size_mismatch`; bytes that are not there at
all are `upload_not_received`; a window that closed is
`upload_reservation_expired`.

## Three things to configure and say out loud

**The acknowledgement.** Direct upload is off until the config carries the
verbatim `DIRECT_UPLOAD_ACKNOWLEDGEMENT` string. It reads:

> I accept that upload bytes bypass my application and are enforced by the
> object store

That is not ceremony. Handing the data path to the object store is a property
the application gives up, and the string makes somebody type it.

**`maxUploadBytes`.** No default. Choose a ceiling and tell the developer what
you chose.

**`ttlSeconds` >= 60.** A shorter window fails real uploads on real networks.

## What it still does not do

- **Not every adapter can sign.** `MemoryStorage` cannot at all.
  `FsStorage` mints a token for `localUploadRoute()` instead, which you mount,
  so the client code is identical in development — but the bytes still travel
  through the process, and `upload.via` says `'server'` rather than
  `'storage'`. Check `via` before telling anyone the bytes bypassed them.
- **No resumable or multipart direct upload.** One PUT is one object. A break
  at 90% loses everything, and files above 5 GB cannot go this way at all.
- **Abandoned reservations accumulate** as invisible `pending` rows until
  something calls `collectUploadReservations()`. Schedule it, and say that you
  did not if you did not. **It defaults to `dryRun: true`**, so a job that
  calls it without `{ dryRun: false }` reports what it would have collected and
  removes nothing. The same is true of `collectStorageOrphans()`. That default
  is deliberate -- both of these delete on the strength of an absence -- but a
  scheduled job left on the default is a cleanup job that has never cleaned
  anything up.

## The content type is still not trustworthy

Signing `content-type` pins it to what the server chose, which is good — but
the server chose it from something the client said. After the upload lands,
decide the real type from the first bytes: `89 50 4E 47 0D 0A 1A 0A` is PNG,
`FF D8 FF` is JPEG, `25 50 44 46` is `%PDF`. Serve user content as an
attachment with `nosniff` regardless, because that is the defence that holds
when the sniffing is wrong.
