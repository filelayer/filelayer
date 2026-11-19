#!/usr/bin/env node
/**
 * EVERY AWS ACTION AND CONDITION KEY ON A PUBLIC PAGE EXISTS.
 *
 *     node tools/check-aws-names.mjs
 *     node tools/check-aws-names.mjs --self-test
 *
 * WHY. Until 20 November 2026 the guide on expiring and revocable links told
 * readers to add an `aws:signatureAge` condition. The key is `s3:signatureAge`;
 * a bucket policy written from the guide would not have done what it said.
 * It was found while drafting an article that links the guide.
 *
 * WHAT IT DOES. Finds every `s3:` and `aws:` IAM name on the public surfaces
 * (not the `aws:s3` inside an ARN) and checks it against AWS's own lists:
 *   - `s3:` names against the actions and condition keys of the Service
 *     Authorization Reference, read from AWS's programmatic service reference
 *     (servicereference.us-east-1.amazonaws.com/v1/s3/s3.json) on each run, so
 *     there is no hand-kept list to go stale;
 *   - `aws:` names against the global condition keys in the IAM User Guide
 *     (reference_policies_condition-keys.html), listed below as of 20 Nov 2026.
 * Condition keys are case-insensitive in IAM, so the comparison is too.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S3_REFERENCE = 'https://servicereference.us-east-1.amazonaws.com/v1/s3/s3.json';

// IAM User Guide, global condition context keys (20 Nov 2026). Tag keys end in
// a slash and are matched by prefix.
const GLOBAL = `PrincipalArn PrincipalAccount PrincipalOrgPaths PrincipalOrgID PrincipalTag/ PrincipalIsAWSService
PrincipalServiceName PrincipalServiceNamesList PrincipalType userid username AssumedRoot FederatedProvider
CrossPartitionSourceRegion TokenIssueTime SignInSessionArn MultiFactorAuthAge MultiFactorAuthPresent ChatbotSourceArn
Ec2InstanceSourceVpc Ec2InstanceSourcePrivateIPv4 SourceIdentity ViaCustomerDomain SourceIp SourceVpc SourceVpcArn
SourceVpce VpceAccount VpceOrgID VpceOrgPaths VpcSourceIp ResourceAccount ResourceOrgID ResourceOrgPaths ResourceTag/
CalledVia CalledViaFirst CalledViaLast CalledViaAWSMCP ViaAWSService ViaAWSMCPService CurrentTime EpochTime referer
RequestedRegion RequestTag/ TagKeys SecureTransport SourceAccount SourceArn SourceOrgID SourceOrgPaths UserAgent
IsMcpServiceAction`.split(/\s+/).map((k) => `aws:${k}`.toLowerCase());

const PUBLIC = (rel) =>
  /^(README|ROADMAP|LIMITATIONS|TRUST|SECURITY)\.md$/.test(rel) ||
  /^(llms\.txt|context7\.json)$/.test(rel) ||
  /^(docs|skills|examples|claude-plugin)\/.*\.(md|json)$/.test(rel) ||
  /^web\/.*\.html$/.test(rel) ||
  /^packages\/core\/(?!CHANGELOG)[^/]*\.md$/.test(rel) ||
  /^packages\/core\/llms\.txt$/.test(rel) ||
  /^packages\/core\/(docs|skills|examples)\/.*\.md$/.test(rel);

export function names(text) {
  return [...text.matchAll(/(?<![\w:-])(aws|s3):([A-Za-z][A-Za-z0-9-]*\/?)/g)]
    .filter((m) => !/arn:$/i.test(text.slice(Math.max(0, m.index - 4), m.index)))
    .map((m) => `${m[1]}:${m[2]}`);
}

export function check(files, s3Known) {
  const problems = [];
  for (const [rel, text] of files) {
    for (const n of new Set(names(text))) {
      const low = n.toLowerCase();
      const ok = n.startsWith('s3:')
        ? s3Known.has(low)
        : GLOBAL.some((g) => (g.endsWith('/') ? low.startsWith(g) : low === g));
      if (!ok) problems.push(`${rel}: \`${n}\` is not an ${n.startsWith('s3:') ? 'Amazon S3 action or condition key' : 'AWS global condition key'}`);
    }
  }
  return problems;
}

async function s3Reference() {
  const res = await fetch(S3_REFERENCE);
  if (!res.ok) throw new Error(`${S3_REFERENCE} answered ${res.status}`);
  const d = await res.json();
  return new Set([
    ...d.Actions.map((a) => `s3:${a.Name}`.toLowerCase()),
    ...d.ConditionKeys.map((c) => c.Name.toLowerCase()),
  ]);
}

let s3Known;
try {
  s3Known = await s3Reference();
} catch (e) {
  console.error(`check-aws-names: could not read AWS's service reference: ${e.message}\n  This check needs the network; it does not fall back to a list of its own.`);
  process.exit(2);
}

if (process.argv.includes('--self-test')) {
  let bad = 0;
  const t = (what, text, expect) => {
    const n = check([['docs/x.md', text]], s3Known).length;
    if (n !== expect) { bad++; console.error(`  self-test FAILED: ${what}: ${n} problem(s), expected ${expect}`); }
  };
  t('the 20 Nov defect, aws:signatureAge', 'Add an `aws:signatureAge` condition', 1);
  t('the right key, s3:signatureAge', 'Add an `s3:signatureAge` condition', 0);
  t('a misspelt action', '`s3:GetObjects`', 1);
  t('a real action and a global key', '`s3:GetObject` with `aws:SecureTransport`', 0);
  t('an ARN is not a key', 'arn:aws:s3:::my-bucket/*', 0);
  t('a tag key', '`aws:ResourceTag/team`', 0);
  if (bad) process.exit(1);
  console.log(`check-aws-names --self-test: 6 controls correct (${s3Known.size} S3 names from AWS's reference).`);
  process.exit(0);
}

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const files = tracked.filter(PUBLIC).map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]);
const problems = check(files, s3Known);
if (problems.length) {
  console.error(`check-aws-names: FAILED, ${problems.length} name(s) AWS does not define\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const count = files.reduce((n, [, t]) => n + names(t).length, 0);
console.log(`check-aws-names: clean. ${count} AWS name(s) across ${files.length} public file(s), each one AWS defines.`);
