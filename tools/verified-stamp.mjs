/**
 * The stamp that says "these verification chains ran, against this tree".
 *
 * A LIBRARY, with no side effects, and that is the correction it exists for.
 * `treeHash` and `readStamp` first lived in `stamp-verified.mjs`, which is also
 * an executable script -- so importing them RAN it, and it exits 2 when given
 * no chain name. Every call to `refuse-unverified-publish.mjs` died at the
 * import with a bare exit 2, and its own `--self-test` passed `--self-test`
 * through as the chain name and recorded a stamp called that.
 *
 * Found by the probes, in under a minute, which is the only reason it is not
 * in a commit. A file that both exports and executes is a module with a side
 * effect; the two concerns are now two files.
 *
 * ---------------------------------------------------------------------------
 * WHY A STAMP AT ALL
 * ---------------------------------------------------------------------------
 *
 * `@filelayer/core@0.28.0` was published while `npm run verify` was red. The
 * preflight is one `&&` chain, it stopped on a failing gate, and a chain that
 * breaks looks exactly like a command that finished.
 *
 * `verify` now ends by writing this stamp, which in an `&&` chain is reachable
 * only if every step before it exited 0 -- so the breakage that hid the failure
 * is what prevents the stamp from existing. `prepublishOnly` reads it and
 * refuses. The mechanism that failed, inverted.
 *
 * Keyed on the git tree hash INCLUDING uncommitted work: content-addressed, so
 * one edited byte after a green run makes the stamp stop matching. A stamp that
 * survived an edit would vouch for a tree nobody verified.
 *
 * Never committed. `.measured/` is ignored on purpose: this attests that a
 * chain ran HERE. A committed stamp would travel to a checkout that ran nothing
 * and assert something false about it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STAMP = join(ROOT, '.measured', 'verified.json');

/** The chains a publish requires, and the npm script that writes each. */
export const REQUIRED = [
  { chain: 'verify', script: 'npm run verify' },
  { chain: 'release', script: 'npm run verify:release' },
];

/**
 * A content key for everything a verification run could have read.
 *
 * TRACKED CONTENT, from `git stash create`, which writes no stash and mutates
 * nothing: it produces a commit object for the current state, including staged
 * and unstaged modifications. Empty output means a clean tree, so HEAD.
 *
 * PLUS THE UNTRACKED FILES, and that part is a correction. `verify-stepwise`
 * keys on the stash tree alone, and `git stash create` does NOT include
 * untracked files -- so the hash moved the moment this file's own siblings were
 * `git add`ed, from cdc48ffb to b7777837, with not one byte of content changed.
 *
 * That is not merely confusing. A new source file, untracked, is read by
 * `verify` and absent from a key computed that way: the stamp would attest to a
 * tree that does not contain the code the gates just ran against. The flow the
 * runbook documents starts from a clean tree so it would rarely bite, but a
 * stamp whose soundness depends on following the runbook is not a guard against
 * not following the runbook.
 *
 * Ignored files are excluded, deliberately. `.measured/` holds this very stamp,
 * and `node_modules` is enormous and platform-dependent; neither is input to
 * what the gates assert about the product.
 */
export function treeHash() {
  // EVERY NON-IGNORED FILE ON DISK, hashed by content, tracked or not.
  //
  // `--cached --others --exclude-standard` is the union of "git knows this
  // file" and "git does not know it and is not ignoring it" -- which is exactly
  // the set a verification run can read.
  //
  // THE OBVIOUS IMPLEMENTATIONS ARE BOTH WRONG, and both were written here
  // before this one. `git stash create`'s tree omits untracked files entirely,
  // so a new source file the gates just ran against is absent from the key.
  // Folding the untracked files in on top of that tree fixes the omission and
  // introduces a worse problem: `git add` moves a file from one half of the
  // formula to the other, so the key changes with NOT ONE BYTE of content
  // changed -- measured, cdc48ffb to b7777837 -- and a stamp written before a
  // routine `git add -A` would refuse the publish that followed it. A guard
  // that cries over staging is a guard somebody removes.
  //
  // Content only, therefore. Staging, committing and unstaging the same bytes
  // all produce the same key, and one edited byte produces a different one.
  const paths = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
    // A tracked path that is deleted on disk is still `--cached`. Dropped here
    // rather than left to fail `hash-object`, and its absence changes the key
    // because the path leaves the digest.
    .filter((p) => existsSync(join(ROOT, p)))
    .sort();

  // `git hash-object` gives each file the id git itself would, so this key is
  // comparable with anything else git says about the same content.
  const ids = execFileSync('git', ['hash-object', '--stdin-paths'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: `${paths.join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  })
    .trim()
    .split('\n');

  const digest = createHash('sha256');
  for (let i = 0; i < paths.length; i++) digest.update(`${paths[i]}\0${ids[i]}\0`);
  return `${paths.length}:${digest.digest('hex')}`;
}

export function readStamp() {
  if (!existsSync(STAMP)) return null;
  try {
    return JSON.parse(readFileSync(STAMP, 'utf8'));
  } catch {
    // A corrupt stamp is treated as no stamp. The consequence is a refused
    // publish and a re-run, which is the safe direction.
    return null;
  }
}
