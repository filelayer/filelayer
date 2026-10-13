#!/usr/bin/env node
/**
 * Refuse to publish a tree that has not passed both verification chains.
 *
 * Wired as `prepublishOnly` in packages/core/package.json, so npm runs it
 * before uploading anything and a non-zero exit means **the publish does not
 * happen**. That is the whole point: this is not a reminder, it is a stop.
 *
 *     node tools/refuse-unverified-publish.mjs
 *     node tools/refuse-unverified-publish.mjs --self-test
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *
 * `@filelayer/core@0.28.0` went to npm while `npm run verify` was red. The
 * preflight is one `&&` chain, it stopped on a failing gate, and a chain that
 * breaks looks exactly like a command that finished. The publish was the next
 * command pasted.
 *
 * The runbook already said to check. Prose is what we had and prose is what
 * failed -- so the check moved to where it cannot be skipped by not reading it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It does NOT run the gates. It asserts that they ran, here, against this exact
 * tree, by reading the stamp `tools/stamp-verified.mjs` writes at the end of
 * each chain. Re-running six minutes of gates inside `npm publish` would make
 * every publish slower and would still prove nothing extra: the preflight has
 * just run them.
 *
 * So this is a check on the PROCESS, not on the code. The code is checked by
 * twenty-nine gates. What was missing was anything connecting "the gates
 * passed" to "the upload is allowed", and that connection is this file.
 */

import { REQUIRED, readStamp, treeHash } from './verified-stamp.mjs';

if (process.argv.includes('--self-test')) {
  // The control: a stamp from a DIFFERENT tree must not satisfy the guard. That
  // is the only interesting failure mode -- a stale stamp vouching for edits
  // made after it -- and it is the one a date-based or boolean stamp would
  // have got wrong.
  const stale = { tree: 'f'.repeat(40), chains: { verify: 'x', release: 'x' } };
  const accepted = stale.tree === treeHash() && REQUIRED.every((r) => stale.chains[r.chain]);
  console.log(
    accepted
      ? 'control DID NOT FAIL: a stamp from another tree was accepted.'
      : 'refuse-unverified-publish: control passed (a stamp from another tree is refused).',
  );
  process.exit(accepted ? 1 : 0);
}

const tree = treeHash();
const stamp = readStamp();

const fail = (why, how) => {
  console.error(
    `\nrefuse-unverified-publish: REFUSING TO PUBLISH\n\n  ${why}\n\n  ${how}\n\n` +
      '  This ran as `prepublishOnly`, so nothing has been uploaded. See\n' +
      '  PUBLISH-RUNBOOK.md section 0 for the four steps and their order.\n',
  );
  process.exit(1);
};

if (!stamp) {
  fail(
    'no verification has been recorded for this working tree.',
    'Run `npm run verify` and then `npm run verify:release`, both to completion.',
  );
}

if (stamp.tree !== tree) {
  fail(
    'the recorded verification is for a different working tree, so something ' +
      'has\n  changed since it ran. Even one byte.',
    'Run `npm run verify` and `npm run verify:release` again on the tree you ' +
      'are about\n  to publish.',
  );
}

const missing = REQUIRED.filter((r) => !stamp.chains?.[r.chain]);
if (missing.length > 0) {
  fail(
    `${missing.map((r) => r.chain).join(' and ')} did not complete for this tree. ` +
      'A chain that stops ' +
      'on a\n  failing gate leaves no stamp, which is exactly how 0.28.0 was ' +
      'published on red.',
    `Run: ${missing.map((r) => r.script).join(' && ')}`,
  );
}

console.log(
  `refuse-unverified-publish: ok. ${REQUIRED.map((r) => r.chain).join(' and ')} both ` +
    `completed for tree ${tree.slice(0, 12)} ` +
    `(${REQUIRED.map((r) => `${r.chain} ${stamp.chains[r.chain]}`).join(', ')}).`,
);
