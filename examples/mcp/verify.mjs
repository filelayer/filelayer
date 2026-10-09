/**
 * Drive `server.ts` the way a client does: launch it as a subprocess and speak
 * the protocol over its stdio.
 *
 *   node verify.mjs
 *
 * Not the in-memory transport. The package's own tests use that, and it proves
 * the tools behave; it does not prove the thing a client actually does, which
 * is spawn a process and exchange newline-delimited JSON with it. Those fail
 * differently: a server that writes one stray line to stdout passes every
 * in-memory test and is unusable from a client.
 *
 * Exits non-zero on the first failure, with the reason.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let checks = 0;
const fail = (what, detail) => {
  console.error(`\n  FAILED: ${what}\n          ${detail}\n`);
  process.exit(1);
};
const ok = (cond, what, detail = '') => {
  checks++;
  if (!cond) fail(what, detail);
  console.log(`  ok  ${what}`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--experimental-strip-types', join(HERE, 'server.ts')],
  env: { ...process.env, FILELAYER_AS: 'user_alice', FILELAYER_ORG: 'org_acme' },
  stderr: 'pipe',
});

const client = new Client({ name: 'filelayer-example-verify', version: '1' });

try {
  await client.connect(transport);
} catch (e) {
  fail('the server did not come up over stdio', String(e.message).slice(0, 300));
}

const payload = (r) => JSON.parse(r.content[0].text);

// ---------------------------------------------------------------------------
// What it offers.
// ---------------------------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();

ok(
  names.join(' ') ===
    'create_share_link file_audit file_info list_files list_shares revoke_share ' +
      'share_with_user unshare_user',
  'it advertises the default seven plus file_audit',
  `got: ${names.join(' ')}`,
);

ok(
  !names.includes('delete_file') && !names.includes('read_file'),
  'the tools nobody asked for are absent',
  `got: ${names.join(' ')}`,
);

for (const t of tools) {
  const keys = Object.keys(t.inputSchema.properties ?? {});
  ok(
    !keys.some((k) => ['as', 'actor', 'subject', 'principal'].includes(k)),
    `${t.name} does not let the caller choose who it is`,
    `arguments: ${keys.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// What it does.
// ---------------------------------------------------------------------------
const listed = payload(await client.callTool({ name: 'list_files', arguments: {} }));
const files = listed.files ?? listed.items ?? listed;
ok(Array.isArray(files) && files.length === 2, 'it lists the two seeded files', JSON.stringify(listed).slice(0, 200));

const target = files.find((f) => f.name === 'engagement-letter.txt');
ok(Boolean(target), 'the engagement letter is one of them', JSON.stringify(files).slice(0, 200));

const info = payload(await client.callTool({ name: 'file_info', arguments: { fileId: target.id } }));
ok(info.name === 'engagement-letter.txt', 'file_info describes it', JSON.stringify(info).slice(0, 200));
ok(
  !('body' in info) && !('content' in info),
  'file_info returns no contents',
  'returning bytes by default would put the document in a model context',
);

// A share that must carry an expiry.
const noExpiry = await client.callTool({
  name: 'share_with_user',
  arguments: { fileId: target.id, user: 'user_bob' },
});
ok(noExpiry.isError === true, 'a share with no expiry is refused', JSON.stringify(noExpiry).slice(0, 200));

const shared = payload(
  await client.callTool({
    name: 'share_with_user',
    arguments: { fileId: target.id, user: 'user_bob', expiresInSeconds: 14 * 86400 },
  }),
);
ok(Boolean(shared.grantId), 'sharing with an expiry returns a grant id', JSON.stringify(shared));

const grants = payload(await client.callTool({ name: 'list_shares', arguments: { fileId: target.id } }));
ok(Array.isArray(grants) && grants.length >= 1, 'the grant is listed', JSON.stringify(grants).slice(0, 200));

const revoked = payload(await client.callTool({ name: 'revoke_share', arguments: { grantId: shared.grantId } }));
ok(revoked.revoked === shared.grantId, 'the grant revokes', JSON.stringify(revoked));

// ---------------------------------------------------------------------------
// A missing file: the error shape is the contract.
// ---------------------------------------------------------------------------
const missing = await client.callTool({
  name: 'file_info',
  arguments: { fileId: '00000000-0000-0000-0000-000000000000' },
});
ok(missing.isError === true, 'a file that is not there is an error');
const err = payload(missing);
ok(err.error === 'not_found', 'the code is not_found', JSON.stringify(err));
ok(err.status === 404, 'the status is 404, which does not confirm existence', JSON.stringify(err));
ok(typeof err.fix === 'string' && err.fix.length > 0, 'the error carries a fix an agent can act on', JSON.stringify(err));
ok(!('reason' in err), 'the internal deny reason is not serialized', JSON.stringify(err));

// ---------------------------------------------------------------------------
// The attribution. This is why the server exists.
// ---------------------------------------------------------------------------
const trail = payload(await client.callTool({ name: 'file_audit', arguments: { limit: 200 } }));
ok(Array.isArray(trail) && trail.length > 0, 'the trail reads back', JSON.stringify(trail).slice(0, 200));

const byAgent = trail.filter((e) => e.userAgent === 'filelayer-example-mcp/1.0');
ok(byAgent.length > 0, 'the agent\'s calls are attributed to the agent', `user agents seen: ${JSON.stringify([...new Set(trail.map((e) => e.userAgent))])}`);
ok(
  trail.some((e) => e.userAgent !== 'filelayer-example-mcp/1.0'),
  'the seeding is NOT attributed to the agent',
  'if every event carried the agent label it would separate nothing',
);
// The two refusals above are NOT here, and both absences are correct.
//
// The share with no expiry never reached the library: `expiresInSeconds` is
// required by the tool's schema, so the protocol refused it. Nothing was
// decided, so there is nothing to record.
//
// The probe at a file id that does not exist IS recorded -- against the SYSTEM
// chain (`org_id IS NULL`), not this tenant's. Charging an enumeration attempt
// to a tenant would itself leak whether the file belongs to them, which is the
// property the 404 exists to protect. Measured: the system chain gains a row
// and the tenant chain does not.
//
// So this server cannot show you id probes, because the chain they land on is
// cross-tenant and a server scoped to one subject has no business reading it.
// That is a real limit of the audit tool and worth knowing before you rely on
// it for "did anyone try ids they should not have".
ok(
  !trail.some((e) => e.fileId === '00000000-0000-0000-0000-000000000000'),
  'the id probe is absent from this tenant\'s trail, as designed',
  `found: ${JSON.stringify(trail.filter((e) => e.fileId === '00000000-0000-0000-0000-000000000000'))}`,
);

await client.close();
console.log(`\n${checks} checks passed, driven over stdio against a spawned server.\n`);
