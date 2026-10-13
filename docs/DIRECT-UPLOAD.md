# Uploading straight to the bucket

The default upload path sends bytes through your process, which is what makes
authorization and auditing possible on the way in. For files measured in
hundreds of megabytes that cost stops being worth paying, and `createUpload()`
takes your process out of the data path.

It is opt-in, and the rest of this page is why.

<!-- doccheck: skip reason="direct upload is opt-in and needs a storage adapter that can sign plus the verbatim acknowledgement; the throwaway instance on this page has neither, by design" -->
```ts
const { file, upload } = await fl.createUpload(principal, orgId, {
  name: 'recording.mp4',
  contentType: 'video/mp4',
  size: declaredSize,            // required and exact
});
// the client PUTs to upload.url with upload.headers, then:
const ready = await fl.completeUpload(principal, file.id);
```

A presigned PUT signs the method, the key and the expiry, and **does not
constrain the body**: a URL minted for a 200 KB avatar accepts three gigabytes.
`createUpload()` signs `content-length` and `content-type` into the credential
so the object store rejects the wrong size or type before accepting it, which on
Cloudflare R2 is the only way to bound the body at all. Until
`completeUpload()` succeeds the row is `pending` and refuses `read`, and
`completeUpload()` asks the store what arrived rather than believing the client.

It is off until the configuration carries the verbatim
`DIRECT_UPLOAD_ACKNOWLEDGEMENT` string, and `maxUploadBytes` has no default.
Below a few tens of megabytes `fl.files.put()` is simpler and strictly safer,
because you see the bytes.

---

Back to the [README](https://github.com/filelayer/filelayer/blob/main/README.md) · [Quickstart](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) · [what it does not do](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
