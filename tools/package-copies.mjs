/**
 * THE DECLARED LIST of files that exist twice: at the repository root and
 * inside the npm package.
 *
 * A LIBRARY. Nothing happens at import, and that is the point of the split:
 * `check-package-copies.mjs` is an executable script, so importing the list
 * from it would RUN it -- the same defect `verified-stamp.mjs` was carved out
 * of `stamp-verified.mjs` to fix.
 *
 * The list was inside the checker until 14 October 2026. It moved so that
 * `tools/sync-package-copies.mjs` can WRITE the copies from the same
 * declarations the checker READS -- including the `rewrite` rules, which are
 * the part a human doing it by hand gets wrong. I copied over QUICKSTART's
 * package copy with `cp` that morning and silently destroyed its declared
 * rewrite; the gates caught it, which is the fourth time this quarter they have
 * caught me doing this by hand. A rule in prose that is broken four times is
 * not a rule, it is a note.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PKG_DIR = 'packages/core';

/**
 * The files that exist at the repository root AND inside the package.
 *
 * `versionStamp` names a regular expression with one capture group that must
 * yield the published version. `null` means the file carries no version and is
 * not expected to. Nothing here hard-codes a version number.
 */
export const COPIES = [
  {
    file: 'README.md',
    why: 'the first thing a stranger reads, on GitHub and in the tarball',
    // NO STAMP, SINCE 0.16.0, AND THAT IS A CHANGE WORTH EXPLAINING. The stamp
    // was the "Each one is current as of `0.4.3`" sentence introducing the
    // limitations list, and the list moved to LIMITATIONS.md, where the stamp
    // went with it. Leaving the regex here would fail the build for a sentence
    // that is correctly somewhere else, and inventing a second version number
    // for this file would be one more hand-maintained figure that can only go
    // stale -- which is the defect this whole family of gates exists for. The
    // npm badge at the top of the README is the live answer.
    versionStamp: null,
  },
  {
    file: 'LICENSE',
    why: 'the licence the package advertises must be the licence it ships',
    versionStamp: null,
  },
  {
    file: 'NOTICE',
    why: 'Apache-2.0 §4(d): the NOTICE travels with the distribution',
    versionStamp: null,
  },
  {
    file: 'skills/filelayer-integration/SKILL.md',
    why:
      'the Agent Skill ships so that it can be copied out of the reader\'s OWN ' +
      'node_modules into .claude/skills/, which is the only channel where the ' +
      'skill and the installed version cannot drift apart. A copy taken from a ' +
      'repository describes whatever is newest; this one describes what they have.',
    versionStamp: /describes `@filelayer\/core` version (\d+\.\d+\.\d+)/,
  },
  ...[
    'skills/filelayer-integration/references/direct-upload.md',
    'skills/filelayer-integration/references/errors.md',
    'skills/filelayer-integration/references/node-http.md',
    'skills/filelayer-integration/references/range-and-media.md',
    'skills/filelayer-integration/references/sharing-and-links.md',
    'skills/filelayer-integration/references/whatwg-runtimes.md',
    // The evidence travels with the package, for the same reason TRUST.md does:
    // the README quotes 23/24 right next to a link to this file, and a reader
    // holding only an install is exactly the reader who should be able to check
    // it -- including the part that says what those numbers do NOT establish.
    'skills/filelayer-integration/evals/MEASUREMENT.md',
    'skills/filelayer-integration/evals/evals.json',
  ].map((file) => ({
    file,
    why: 'a reference file of the shipped Agent Skill; SKILL.md points at it by relative path',
    versionStamp: null,
  })),
  {
    file: 'llms.txt',
    why: 'the orientation file for an agent that has only node_modules',
    versionStamp: /\bversion (\d+\.\d+\.\d+)\b/,
  },
  {
    file: 'openapi.json',
    why: 'the machine-readable shape of the API, for the same reader',
    versionStamp: /"version":\s*"(\d+\.\d+\.\d+)"/,
  },
  {
    // AT docs/ ON BOTH SIDES, so the link in llms.txt and the file on disk are
    // the same path as well as the same bytes.
    file: 'docs/QUICKSTART.md',
    why:
      'the install-to-first-file document. An agent integrating this package was ' +
      'told by llms.txt to start here, found it was the one Start-here file not ' +
      'in the tarball, and had to fetch it over the network. Measured 3 October 2026.',
    versionStamp: null,
    // SEMANTICS.md ships at the PACKAGE ROOT and lives at `packages/core/` in
    // the checkout, so the relative link to it cannot be the same string in
    // both copies. Rewritten rather than turned into a URL because this is a
    // document that ships, and the reader this file was written for has an
    // install and no browser. See the note on the example files below.
    rewrite: [['](../packages/core/SEMANTICS.md)', '](../SEMANTICS.md)']],
  },
  {
    file: 'LIMITATIONS.md',
    why:
      'the complete list of what this does not do. It was 117 of the README\'s ' +
      '528 lines until 5 October 2026, when a reader pointed out that reads as ' +
      'fragility rather than candour; moving it must not make it harder to ' +
      'reach, so it ships.',
    versionStamp: /as of\s+`(\d+\.\d+\.\d+)`/,
  },
  {
    file: 'TRUST.md',
    why:
      'the evidence table, and the document the README puts first. It was cited ' +
      'by absolute URL only, so the one reader this project claims to design for ' +
      '-- an install, no browser -- could not reach the numbers that decide ' +
      'whether to depend on this. Found 4 October 2026 by an analyst given only ' +
      'the tarball.',
    versionStamp: /\|\s*Version\s*\|\s*(\d+\.\d+\.\d+)\s*—/,
  },
  {
    file: 'SECURITY.md',
    why: 'how to report a vulnerability, and which versions are supported. A reviewer needs it offline.',
    versionStamp: /pre-1\.0 \(`(\d+\.\d+\.\d+)`\)/,
  },
  {
    file: 'docs/LIVE-S3-TESTS.md',
    why:
      'the CHANGELOG names it three times and `docs/` ships, so a reader who ' +
      'found `docs/` in their install went looking for it and came up empty.',
    versionStamp: null,
  },
  {
    file: 'docs/VERIFY-WHAT-YOU-INSTALLED.md',
    why:
      'the procedure for running the shipped suite against the copy you installed. It has to ' +
      'travel WITH that copy: a reader holding the tarball is exactly the reader who needs it, ' +
      'and until 5 October 2026 the only published remedy was "clone the repository", which ' +
      'verifies something other than what they were sent.',
    versionStamp: null,
  },
  // THE FOUR PAGES THE README SHED on 14 October 2026. Each one is prose a
  // reader used to find in the README, so the tarball has to keep carrying it:
  // an install whose README now says "see docs/MCP.md" and whose `docs/` has no
  // such file is a worse state than the long README it replaced.
  {
    file: 'docs/CLI.md',
    why:
      '`filelayer doctor` is the thing you run when a deployment is wrong, which is exactly ' +
      'the moment you have the install and not the repository.',
    versionStamp: null,
  },
  {
    file: 'docs/AGENT-SKILL.md',
    why:
      'it tells you to copy the skill out of your own node_modules, so it has to be readable ' +
      'from that same node_modules.',
    versionStamp: null,
  },
  {
    file: 'docs/DIRECT-UPLOAD.md',
    why:
      'direct upload is off until the configuration carries a verbatim acknowledgement string, ' +
      'and the page that explains why must ship with the code that refuses.',
    versionStamp: null,
  },
  {
    file: 'docs/MCP.md',
    why:
      'the MCP server ships in the package and its one load-bearing property -- the subject is ' +
      'fixed at construction -- is argued here and nowhere else in the tarball.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/deleting-files-and-orphaned-objects.md',
    why: 'the fourth guide: the sweeper deletes on an absence, and a partial answer is an absence.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/deleting-files-and-orphaned-objects.proof.mjs',
    why: 'the script that demonstrates it, both directions.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/README.md',
    why: 'the index. With three guides this is a destination rather than loose files.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/revoking-delegated-access.md',
    why:
      'the sixth guide: whether onward access CAN be revoked is decided by the ' +
      'schema that stores the share, so a reader who meets this after shipping ' +
      'has already lost. It ships for the agent with an install and no browser.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/revoking-delegated-access.proof.mjs',
    why:
      'the script that produced it, including the budget measurement that needs ' +
      'fifty backends and therefore a real PostgreSQL.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/tamper-evident-file-audit.md',
    why:
      'the seventh guide, and the one whose headline claim is a LIMITATION -- ' +
      'replay cannot detect truncation of the most recent events. That belongs ' +
      'in the tarball for the same reason LIMITATIONS.md does.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/tamper-evident-file-audit.proof.mjs',
    why: 'the script that demonstrates the fork, which one backend cannot stage.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/serving-private-files.md',
    why:
      'the fifth guide: a presigned redirect cannot be revoked before its TTL, ' +
      'and the moment you proxy instead, Range is yours -- including the four ' +
      'cases that look like a 416 and must be answered 200.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/serving-private-files.proof.mjs',
    why: 'the script that produces both tables, with no PostgreSQL server to start.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/multi-tenant-file-access.md',
    why: 'the third guide: RLS filters reads and does not stop a cross-tenant write.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/multi-tenant-file-access.proof.mjs',
    why: 'the script that demonstrates it, against a real PostgreSQL.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/private-file-uploads.md',
    why:
      'the second guide. It is the one where this library is NOT the answer to ' +
      'the main question, which is the point: a guide that only ever concludes ' +
      '"use us" is an advertisement, and nothing cites an advertisement.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/expiring-and-revocable-file-links.proof.mjs',
    why:
      'the script that produced the numbers in the guide beside it. It ships for ' +
      'the same reason the tests do: a measurement nobody can re-run is an ' +
      'assertion with a confident voice.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/expiring-and-revocable-file-links.md',
    why:
      'the first of the guides: the answer to a question whose usual answer is ' +
      'wrong. It ships because the reader we most want is an agent with an ' +
      'install and no browser, and because llms.txt names it.',
    versionStamp: null,
  },
  ...[
    'examples/tier1-avatar/package.json',
    'examples/tier2-user-files/package.json',
    'examples/tier3-org-roles/package.json',
    'examples/vault/package.json',
    'examples/starter/server.ts',
    'examples/starter/verify.mjs',
    'examples/starter/README.md',
    'examples/starter/package.json',
    'examples/starter/.env.example',
    // The Next.js example. Byte-identical with no rewrite, unlike the tier
    // examples below, because it imports `@filelayer/core` by name -- which is
    // what you paste into your own project, and is also why `verify:nextjs`
    // has to install the tarball to run it.
    // The MCP example. Same reasoning as the Next.js one: it imports
    // `@filelayer/core` and `@filelayer/core/mcp` by name, so it is what you
    // paste into your own project.
    'examples/mcp/README.md',
    'examples/mcp/package.json',
    'examples/mcp/server.ts',
    'examples/mcp/verify.mjs',
    'examples/nextjs/README.md',
    'examples/nextjs/package.json',
    'examples/nextjs/verify.mjs',
    'examples/nextjs/lib/filelayer.ts',
    'examples/nextjs/app/[...filelayer]/route.ts',
    'examples/nextjs/app/api/files/route.ts',
    'examples/nextjs/app/api/files/[id]/share/route.ts',
  ].map((file) => ({
    file,
    why: 'a runnable example the documentation points at; shipping it is what makes it readable offline',
    versionStamp: null,
  })),

  // THE FOUR FILES THAT CANNOT BE BYTE-IDENTICAL, AND THE ONE LINE THAT DIFFERS.
  //
  // These four import the library by a RELATIVE path, and the two copies sit at
  // different depths, so one path cannot be correct in both places:
  //
  //   examples/tier1-avatar/app.ts                -> ../../packages/core/src/index.ts
  //   packages/core/examples/tier1-avatar/app.ts  -> ../src/index.ts
  //
  // Before 4 October the copies held the root's path verbatim, so from the copy
  // it resolved to `packages/core/packages/core/src/index.ts` and the copies
  // could not be imported at all. Nothing noticed, because the only thing that
  // imported these examples was `test/tiers.test.ts` and
  // `test/vault-example.test.ts` reaching THREE levels up to the root copies --
  // a path that itself escapes the package root in an install, so those 28
  // tests did not run for anyone using the shipped suite either. Two wrong
  // paths that cancelled out in the repository and failed together everywhere
  // else. Found by an outside analyst holding only the published tarball.
  //
  // The tests now import `../examples/`, the copies carry `../src/`, and both
  // resolve in the repository and in an install. The rewrite below is what
  // keeps the rest of these four files verified: it is applied to the root file
  // and the result must match the copy EXACTLY, and the check fails if the
  // pattern is absent from the root -- a rewrite rule that stops applying would
  // otherwise quietly collapse back into byte-identity and pass.
  ...[
    'examples/tier1-avatar/app.ts',
    'examples/tier2-user-files/app.ts',
    'examples/tier3-org-roles/app.ts',
    'examples/vault/server.ts',
  ].map((file) => ({
    file,
    why:
      'a runnable example the documentation points at, and one the shipped test suite ' +
      'imports, so the package copy must resolve the library from the package root',
    versionStamp: null,
    rewrite: [["'../../packages/core/src/index.ts'", "'../../src/index.ts'"]],
  })),
];
