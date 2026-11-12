# Filelayer in the browser

Nine steps of `@filelayer/core`, as published on npm, with nothing to install
and no account: an upload, a refused read from another organization, a share
link that is downloaded and then revoked, and the audit trail that recorded
both refusals.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/filelayer/filelayer/tree/main/examples/in-the-browser?file=demo.mjs)

It runs in Chromium-based browsers, Safari and Firefox. StackBlitz marks
WebContainers for Safari and Firefox as beta. It takes about 50 seconds, most
of it `npm install`. Or run it on your machine, with Node 22.18 or later:

```bash
git clone https://github.com/filelayer/filelayer.git
cd filelayer/examples/in-the-browser
npm install
npm start
```

## What it prints

From a real run. The file id, the link secret and the times differ on every run.

```
1. Start Filelayer on PGlite with in-memory storage
   -> ready

2. Create two organizations: acme (owner alice) and globex (owner mallory)
   -> created

3. alice uploads q4.pdf into acme
   -> file d49d772b-b16f-4acb-ba19-131a8b9cbecd

4. mallory, from another organization, reads it
   -> refused: 404 not_found

5. alice creates a share link (1 hour, at most 3 downloads)
   -> URL your app would serve: http://localhost:3000/d/y5_3mQIPaiHXXxKPLSyGHjj8v2dmR8KKC9xL6gAmIro

6. Someone with the link downloads it
   -> q4.pdf, 13 bytes, "Q4 board deck", 2 downloads left

7. alice revokes it; the same link is used again
   -> refused: 404 not_found

8. acme's audit trail, denials only
   -> 2 events
   2026-11-12T17:20:04.154Z mallory file.read deny:no_membership q4.pdf @acme
   2026-11-12T17:20:04.250Z anonymous file.read deny:grant_revoked q4.pdf @acme

9. Verify the hash chain of the audit trail
   -> valid=true, 11 events checked
```

Step 5 prints the URL your application would serve the link at. Nothing listens
on `localhost:3000` in this demo, so that URL is not meant to open; step 6
redeems the link's secret directly.

## What it runs on

- `Filelayer.quickstart()`: PGlite, which is PostgreSQL compiled to WebAssembly,
  and in-memory storage. Nothing leaves the process.
- The version of `@filelayer/core` pinned in `package.json`, which is the
  current release.

For a real deployment, the same calls run on your PostgreSQL and your S3 or R2
bucket; [QUICKSTART.md](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) shows the switch.
