// Whose failure is a failed `npm install` in the scorer (score.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whose failure is a failed `npm install`? The scorer's, only when the npm
 * registry itself could not be reached: a connection error to
 * registry.npmjs.org in the scorer's egress log, or a 5xx or 429 from it in
 * npm's log. Any other failure is the agent's, including a dependency that
 * reaches a host the scorer does not allow (allowlist-score.txt): declared in
 * PREREG.md, the same for both arms (cold review, I6).
 */
export function installVerdict(out) {
  // No exit code: the scorer stopped before installing (its global limit);
  // what it wrote, a scorer error, stands.
  if (!existsSync(join(out, 'install.exit'))) return { ok: true };
  const exit = readFileSync(join(out, 'install.exit'), 'utf8').trim();
  if (exit === '0') return { ok: true };
  const log = existsSync(join(out, 'install.log')) ? readFileSync(join(out, 'install.log'), 'utf8') : '';
  const egress = existsSync(join(out, 'score-egress.jsonl'))
    ? readFileSync(join(out, 'score-egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // npm's own verdict on the package comes first: a missing version, an
  // unresolvable tree or a bad manifest is the agent's, whatever the network
  // did meanwhile (cold review of 1bba1d8, N-N3).
  const agentsOwn = /npm error code (E404|ETARGET|ERESOLVE|EBADENGINE|ENOENT|EJSONPARSE|EINVALIDPACKAGENAME|ENOVERSIONS|E403)\b/.test(log);
  const npmSaysNetwork = /(E50[0-9]|E429)[\s\S]{0,300}registry\.npmjs\.org|registry\.npmjs\.org[\s\S]{0,300}(E50[0-9]|E429)/.test(log) ||
    /npm error code (ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EPIPE|ERR_SOCKET_TIMEOUT)\b/.test(log);
  // An install that ran out of time (timeout's exit 124) is the scorer's only
  // if npm itself failed the way a network fails: a project whose install is
  // slow, or that waits on something, is the agent's (cold review of d89b967).
  const timedOut = exit === '124';
  const registryDown = !agentsOwn && (timedOut ? npmSaysNetwork
    : egress.some((e) => e.host === 'registry.npmjs.org' && e.error) || npmSaysNetwork);
  const refused = [...new Set(egress.filter((e) => e.allowed === false).map((e) => e.host))];
  return { ok: false, network: registryDown, refused, exit };
}
