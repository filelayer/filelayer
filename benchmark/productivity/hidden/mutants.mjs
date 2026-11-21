#!/usr/bin/env node
/**
 * EVERY CHECK MUST BE SEEN TO FAIL.
 *
 * A battery that passes against the reference proves nothing by itself: a
 * check that matches nothing passes too. Each mutant below breaks one rule of
 * REQUIREMENTS.md in a copy of the arm B reference, and names the checks that
 * must catch it. The run fails if a mutant survives any check it names, or if
 * the unmutated reference fails anything.
 *
 *   node benchmark/productivity/hidden/mutants.mjs [--only M03,M07]
 *   node benchmark/productivity/hidden/mutants.mjs --task 2
 *
 * --task 2 mutates the task-2 reference (reference/b-own-t2) instead, with the
 * T-mutants below, and scores the task-2 checks as well.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEnv, startServer } from '../harness/local-env.mjs';
import { client } from './client.mjs';
import { runFunctional } from './functional.mjs';
import { runAttacks } from './attacks-adapter.mjs';
import { runTask2 } from './task2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK = process.argv.includes('--task') ? Number(process.argv[process.argv.indexOf('--task') + 1]) : 1;
const REF = join(HERE, '..', 'reference', TASK === 2 ? 'b-own-t2' : 'b-own');

// [id, what it breaks, file, from, to, checks that must fail]
export const MUTANTS = [
  ['M01', 'a document is looked up by id alone, not by id and org', 'src/app.mjs',
    "one('SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [docId, orgId])",
    "one('SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL', [docId])", ['A2']],
  ['M02', 'a viewer may upload', 'src/app.mjs',
    "if (s.role === 'viewer') return s.deny(403, 'insufficient_role');\n    const { name, contentType, content }",
    "const { name, contentType, content }", ['F09', 'F26']],
  ['M03', 'no nosniff on downloads', 'src/app.mjs',
    "res.set('X-Content-Type-Options', 'nosniff');", '', ['F12', 'F18', 'F1']],
  ['M04', 'downloads are cacheable', 'src/app.mjs',
    "res.set('Cache-Control', 'private, no-store');", "res.set('Cache-Control', 'public, max-age=3600');", ['F12', 'F18', 'B3']],
  ['M05', 'a revoked link still works', 'src/app.mjs',
    "if (share.revoked_at) return refuse('revoked');", '', ['F22', 'F24', 'B2'],
    ['WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', 'WHERE id = $1 AND expires_at > now()']],
  ['M06', 'a wrong password consumes a download', 'src/app.mjs',
    "if (share.password_hash) {\n        const given",
    "await db.query('UPDATE shares SET download_count = download_count + 1 WHERE id = $1', [share.id]);\n      if (share.password_hash) {\n        const given",
    ['F19', 'B6']],
  ['M07', 'the download cap is checked, then taken, in two steps', 'src/app.mjs',
    'AND (max_downloads IS NULL OR download_count < max_downloads)', '', ['F19', 'F20', 'B5']],
  ['M08', 'an admin may make someone owner', 'src/app.mjs',
    "if (mine === 'admin' && (current === 'owner' || next === 'owner')) return 'insufficient_role';", '', ['F05', 'D2']],
  ['M09', "a stranger's refused request is not recorded", 'src/app.mjs',
    "        await audit({\n          action, decision: 'deny', actorId: s.userId,",
    "        if (false) await audit({\n          action, decision: 'deny', actorId: s.userId,", ['F26', 'E1']],
  ['M10', 'a document that exists answers a stranger 403, a missing one 404', 'src/app.mjs',
    "        reason: 'not_a_member',\n        });\n        return res.status(404).json(NOT_FOUND);",
    "        reason: 'not_a_member',\n        });\n        if (req.params.documentId && (await one('SELECT id FROM documents WHERE id = $1', [req.params.documentId]))) return fail(res, 403, 'forbidden');\n        return res.status(404).json(NOT_FOUND);",
    ['F14', 'C1']],
  ['M11', 'the filename goes into the header as it is', 'src/app.mjs',
    "res.set('Content-Disposition', disposition(doc.name));",
    "res.setHeader('Content-Disposition', 'attachment; filename=\"' + doc.name + '\"');", ['F2']],
  ['M12', 'expiry is not enforced', 'src/app.mjs',
    "if (share.expires_at <= new Date()) return refuse('expired');", '', ['F21', 'F24', 'B4'],
    ['WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', 'WHERE id = $1 AND revoked_at IS NULL']],
  ['M13', 'the share listing returns the URL', 'src/app.mjs',
    '    revoked: r.revoked_at !== null,\n  });', "    revoked: r.revoked_at !== null,\n    url: `${baseUrl}/s/${r.token_hash}`,\n  });", ['F23']],
  ['M14', "a member may delete anyone's document", 'src/app.mjs',
    "(s.role === 'member' && doc.uploaded_by === s.userId)", "(s.role === 'member')", ['F15']],
  ['M15', 'a member may read the audit trail', 'src/app.mjs',
    "if (RANK[s.role] < RANK.admin) return s.deny(403, 'insufficient_role');\n    const limit = limitOf(req.query.limit, 100, 1000);",
    'const limit = limitOf(req.query.limit, 100, 1000);', ['F25']],
  ['M16', 'the last owner can step down', 'src/app.mjs',
    "if (current === 'owner' && role !== 'owner' && (await ownerCount(s.orgId)) <= 1) return s.deny(409, 'last_owner');", '', ['F07']],
  ['M17', 'an unregistered id gets 401 under an org', 'src/app.mjs',
    "if (!s.userId) return fail(res, 401, 'unauthenticated');",
    "if (!s.userId || !(await one('SELECT id FROM users WHERE id = $1', [s.userId]))) return fail(res, 401, 'unauthenticated');",
    ['F28', 'C3']],
  ['M18', 'a stranger can mint a share over another org’s document', 'src/app.mjs',
    "app.post('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.create', async (req, res, s) => {\n    const doc = await liveDoc(s.orgId, req.params.documentId);",
    "app.post('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.create', async (req, res, s) => {\n    const doc = await one('SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL', [req.params.documentId]);",
    ['A5']],
  ['M19', 'deleting a document leaves its links working', 'src/app.mjs',
    "if (share.doc_deleted) return refuse('document_deleted');", '', ['F15']],
  ['M20', 'a share download is not recorded', 'src/app.mjs',
    "await audit({ action: 'share.download', decision: 'allow',", "if (false) await audit({ action: 'share.download', decision: 'allow',", ['F25', 'E2']],
  ['M21', "another org's audit events leak into the org's trail", 'src/app.mjs',
    "'SELECT * FROM audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT $2', [s.orgId, limit]",
    "'SELECT * FROM audit_events WHERE $1::text IS NOT NULL ORDER BY seq DESC LIMIT $2', [s.orgId, limit]", ['F25']],
  ['M22', 'malformed JSON is a 500', 'src/app.mjs',
    "if (err?.type === 'entity.parse.failed' || err?.status === 400) return fail(res, 400, 'invalid_request');", '', ['F29']],
];

function mutate(m) {
  const [id, , file, from, to, , also] = m;
  const dir = mkdtempSync(join(tmpdir(), `mutant-${id}-`));
  cpSync(REF, dir, { recursive: true, filter: (p) => !p.includes('node_modules') });
  symlinkSync(join(REF, 'node_modules'), join(dir, 'node_modules'));
  const path = join(dir, file);
  const src = readFileSync(path, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`${id}: the text to mutate occurs ${n} times in ${file}`);
  let out = src.replace(from, to);
  if (also) {
    const k = out.split(also[0]).length - 1;
    if (k !== 1) throw new Error(`${id}: the second text to mutate occurs ${k} times in ${file}`);
    out = out.replace(also[0], also[1]);
  }
  writeFileSync(path, out);
  return dir;
}

// The task-2 mutants: each breaks one rule of prompts/task2-change.md.
export const MUTANTS_T2 = [
  ['T01', 'the event does not carry the reason', 'src/app.mjs',
    "revokeReason: reason ?? null });", "revokeReason: null });", ['T2-01']],
  ['T02', 'an invalid reason is checked only after revoking', 'src/app.mjs',
    "    if (reason !== undefined && !isStr(reason, 1, 200)) return fail(res, 400, 'invalid_request');\n", "", ['T2-03'],
    ["    await s.allow({ shareId: share.id, documentId: share.document_id, revokeReason: reason ?? null });",
     "    if (reason !== undefined && !isStr(reason, 1, 200)) return fail(res, 400, 'invalid_request');\n    await s.allow({ shareId: share.id, documentId: share.document_id, revokeReason: reason ?? null });"]],
  ['T03', 'a reason of 200 characters is refused', 'src/app.mjs',
    "!isStr(reason, 1, 200)", "!isStr(reason, 1, 199)", ['T2-04']],
  ['T04', 'a null reason is taken as no reason', 'src/app.mjs',
    "if (reason !== undefined && !isStr(reason, 1, 200))", "if (reason != null && !isStr(reason, 1, 200))", ['T2-03']],
  ['T05', 'a second revocation overwrites the time and the reason', 'src/app.mjs',
    "WHERE id = $1 AND revoked_at IS NULL`", "WHERE id = $1`", ['T2-05', 'T2-06']],
  ['T06', 'a refused revocation stores its reason', 'src/app.mjs',
    "    if (!mayRevoke) return s.deny(403,",
    "    if (!mayRevoke && req.body?.reason) await db.query('UPDATE shares SET revoke_reason = $2 WHERE id = $1', [share.id, req.body.reason]);\n    if (!mayRevoke) return s.deny(403,",
    ['T2-07']],
  ['T07', 'a denial carries the reason it was sent', 'src/app.mjs',
    "if (!mayRevoke) return s.deny(403, 'insufficient_role', { shareId: share.id, documentId: share.document_id });",
    "if (!mayRevoke) return s.deny(403, 'insufficient_role', { shareId: share.id, documentId: share.document_id, revokeReason: req.body?.reason ?? null });",
    ['T2-07']],
  ['T08', 'the listing has no revokedAt', 'src/app.mjs',
    "    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,\n", "", ['T2-01', 'T2-02']],
  ['T09', 'the org trail drops the reason', 'src/app.mjs',
    "    revokeReason: r.revoke_reason,\n  });\n  const limitOf", "  });\n  const limitOf", ['T2-01', 'T2-08']],
];

async function score(dir) {
  const envH = await startEnv();
  let server;
  try {
    server = await startServer(dir, envH.env);
    const make = () => client(server.baseUrl, server.adminToken);
    const f = await runFunctional(make);
    const a = await runAttacks(make);
    const t = TASK === 2 ? await runTask2(make) : { results: [] };
    const failed = new Set([
      ...t.results.filter((r) => !r.pass).map((r) => r.id),
      ...f.results.filter((r) => !r.pass).map((r) => r.id),
      ...a.results.filter((r) => r.scored && r.verdict !== 'defended').map((r) => r.id),
    ]);
    return failed;
  } finally {
    await server?.stop();
    await envH.stop();
  }
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
let bad = 0;
if (!only) {
  const base = await score(REF);
  console.log(`reference: ${base.size === 0 ? 'every check passes' : `FAILS ${[...base].join(', ')}`}`);
  if (base.size) bad++;
}
for (const m of TASK === 2 ? MUTANTS_T2 : MUTANTS) {
  const [id, what, , , , must] = m;
  if (only && !only.includes(id)) continue;
  const dir = mutate(m);
  try {
    const failed = await score(dir);
    const missed = must.filter((c) => !failed.has(c));
    const verdict = missed.length ? `SURVIVES ${missed.join(', ')}` : 'caught';
    console.log(`${id} ${what}: ${verdict} (failed: ${[...failed].join(', ') || 'nothing'})`);
    if (missed.length) bad++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (bad) {
  console.error(`mutants: ${bad} problem(s)`);
  process.exit(1);
}
console.log('mutants: every mutant is caught by every check it names');
