// tools/loc.js -- reproducible line count. Run: npm run loc
//
// COUNTING METHOD (stated so a reader can re-derive every number):
//
//   APPLICATION  = code a developer building Vault on Supabase must write and
//                  own. SQL schema, RLS policies, audit functions, app logic,
//                  share gateway.
//   PLATFORM     = code Supabase itself operates, recreated here only so the
//                  policies can execute. NOT counted. If this were a real
//                  Supabase project the file would not exist.
//   TEST/TOOLING = the suite, harness and this script. NOT counted.
//
//   GROSS = every line in APPLICATION files, including blanks and comments.
//   NET   = GROSS minus blank lines and comment-only lines (`--`, `//`, and
//           lines inside /* */ blocks). Comments here are unusually dense
//           because each one records a decision, so NET is the fairer figure
//           and GROSS is reported alongside it for transparency.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const GROUPS = {
  APPLICATION: [
    ['sql/10_app_schema.sql', 'schema: orgs, members, documents, share_links, audit'],
    ['sql/20_rls_policies.sql', 'authorization kernel + 19 RLS policies'],
    ['sql/25_config_b_lockdown.sql', 'Config B: force all reads through the gateway'],
    ['sql/30_audit.sql', 'tamper-evident audit chain + verifier'],
    ['src/app/vault.js', 'upload / download / delete / membership / audit read'],
    ['src/app/share.js', 'share links: expiry, password, cap, revocation, gateway'],
  ],
  'PLATFORM (not counted)': [
    ['sql/00_platform_emulation.sql', 'auth + storage schema Supabase provides'],
    ['src/platform/supabase.js', 'Storage API + signed URLs Supabase provides'],
  ],
  'TEST / TOOLING (not counted)': [
    ['test/setup.js', ''],
    ['test/vault.test.js', ''],
    ['sql/90_rbac_jwt_variant.sql', 'measurement artefact only'],
    ['tools/loc.js', ''],
  ],
};

function count(rel) {
  const lines = readFileSync(join(root, rel), 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let net = 0, inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (inBlock) { if (l.includes('*/')) inBlock = false; continue; }
    if (l === '') continue;
    if (l.startsWith('--') || l.startsWith('//')) continue;
    if (l.startsWith('/*')) { if (!l.includes('*/')) inBlock = true; continue; }
    net++;
  }
  return { gross: lines.length, net };
}

let appGross = 0, appNet = 0;
for (const [group, files] of Object.entries(GROUPS)) {
  console.log(`\n${group}`);
  let g = 0, n = 0;
  for (const [rel, note] of files) {
    const c = count(rel);
    g += c.gross; n += c.net;
    console.log(`  ${String(c.gross).padStart(5)} ${String(c.net).padStart(5)}  ${rel}${note ? '   -- ' + note : ''}`);
  }
  console.log(`  ${String(g).padStart(5)} ${String(n).padStart(5)}  SUBTOTAL (gross, net)`);
  if (group === 'APPLICATION') { appGross = g; appNet = n; }
}
console.log(`\nAPPLICATION LOC:  gross ${appGross}   net ${appNet}`);
