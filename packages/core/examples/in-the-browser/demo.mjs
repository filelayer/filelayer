// Every step below is a real call into @filelayer/core, as published on npm.
// PGlite is PostgreSQL compiled to WebAssembly; the bytes live in memory.
// Nothing leaves this process: no server of ours, no account, no key.
import { Filelayer } from '@filelayer/core';

const step = (n, what, result) => console.log(`\n${n}. ${what}\n   -> ${result}`);

const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
step(1, 'Start Filelayer on PGlite with in-memory storage', 'ready');

await fl.orgs.create('acme', { name: 'Acme Inc', owner: 'alice' });
await fl.orgs.create('globex', { name: 'Globex', owner: 'mallory' });
step(2, 'Create two organizations: acme (owner alice) and globex (owner mallory)', 'created');

const { id } = await fl.files.put(new TextEncoder().encode('Q4 board deck'), {
  org: 'acme',
  owner: 'alice',
  name: 'q4.pdf',
  contentType: 'application/pdf',
});
step(3, 'alice uploads q4.pdf into acme', `file ${id}`);

try {
  await fl.files.get(id, { as: 'mallory' });
  step(4, 'mallory, from another organization, reads it', 'ALLOWED: this would be a bug');
} catch (e) {
  step(4, 'mallory, from another organization, reads it', `refused: ${e.status} ${e.code}`);
}

const share = await fl.shares.create(id, { as: 'alice', expiresIn: 3600, maxDownloads: 3 });
// This is the URL your application would serve the link at. Nothing is
// listening on localhost:3000 here, so it is printed, not opened.
step(5, 'alice creates a share link (1 hour, at most 3 downloads)', `URL your app would serve: ${share.url}`);

const dl = await fl.shares.redeem(share.secret);
const text = new TextDecoder().decode(dl.body);
step(6, 'Someone with the link downloads it', `${dl.file.name}, ${dl.body.byteLength} bytes, "${text}", ${dl.remainingDownloads} downloads left`);

await fl.shares.revoke(share.grantId, { as: 'alice' });
try {
  await fl.shares.redeem(share.secret);
  step(7, 'alice revokes it; the same link is used again', 'ALLOWED: this would be a bug');
} catch (e) {
  step(7, 'alice revokes it; the same link is used again', `refused: ${e.status} ${e.code}`);
}

const denials = await fl.orgs.audit('acme', { as: 'alice', decision: 'deny' });
step(8, "acme's audit trail, denials only", `${denials.length} events`);
for (const r of denials) console.log(`   ${r.summary}`);

const chain = await fl.orgs.verifyAudit('acme', { as: 'alice' });
step(9, 'Verify the hash chain of the audit trail', `valid=${chain.valid}, ${chain.checked} events checked`);
