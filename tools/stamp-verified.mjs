#!/usr/bin/env node
/**
 * Record that a verification chain finished, for this exact working tree.
 *
 *     node tools/stamp-verified.mjs verify
 *     node tools/stamp-verified.mjs release
 *
 * Called as the last step of `npm run verify` and `npm run verify:release`.
 * `tools/verified-stamp.mjs` holds the reasoning and the shared helpers; this
 * file only writes.
 *
 * THE CHAIN NAME IS CHECKED AGAINST THE KNOWN SET rather than taken as given.
 * The first version accepted any string, and its sibling's `--self-test` passed
 * `--self-test` through as the chain name and recorded a stamp called that --
 * a file whose whole job is to attest to something, attesting to a flag.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { REQUIRED, STAMP, readStamp, treeHash } from './verified-stamp.mjs';

const known = REQUIRED.map((r) => r.chain);
const chain = process.argv[2];
if (!chain || !known.includes(chain)) {
  console.error(
    `stamp-verified: name one of ${known.join(', ')}; got ${JSON.stringify(chain ?? null)}.\n` +
      '  A stamp is an assertion that a named chain ran. An unknown name would be an\n' +
      '  assertion about nothing.',
  );
  process.exit(2);
}

const tree = treeHash();
const prev = readStamp();
// A different tree means every previous chain attested to different content.
// Dropped rather than merged: carrying one forward would let a `verify` from
// before an edit vouch for the code after it.
const chains = prev && prev.tree === tree ? { ...prev.chains } : {};
chains[chain] = new Date().toISOString();

mkdirSync(dirname(STAMP), { recursive: true });
writeFileSync(STAMP, `${JSON.stringify({ tree, chains }, null, 2)}\n`);
console.log(
  `stamp-verified: ${chain} completed for tree ${tree.slice(0, 12)} ` +
    `(recorded: ${Object.keys(chains).sort().join(', ')}).`,
);
