#!/usr/bin/env node
/**
 * Run the ONE shared adversarial suite against every implementation.
 *
 *   node benchmark/adversarial/run.mjs            # all of them, print a matrix
 *   node benchmark/adversarial/run.mjs filelayer  # one of them, verbose
 *   node benchmark/adversarial/run.mjs --md       # emit RESULTS.md
 *
 * Exit code is 1 if any implementation records a BREACH, so this is usable as
 * a CI gate for all five at once -- which is the point of writing it once.
 *
 * A fresh world is built per attack. Attacks mutate state (revocations,
 * deletions, role changes) and a shared world would make results depend on
 * execution order, which is exactly the kind of thing that lets a suite
 * quietly flatter whoever it was written by.
 */
import { ATTACKS } from './attacks.mjs';

// --published scores the @filelayer/core that benchmark/package.json pins, as
// installed from npm, instead of this working tree. That is the run the
// published numbers come from; the plain run is the CI gate on the tree.
const PUBLISHED = process.argv.includes('--published');
// Controls are reported but never decide which attacks count as shared.
const CONTROL = new Set(['filelayer-prerebuild']);
const ADAPTERS = [
  {
    name: 'filelayer',
    load: () => import(PUBLISHED ? './adapters/filelayer.mjs?published' : './adapters/filelayer.mjs'),
  },
  { name: 'supabase', load: () => import('./adapters/supabase.mjs') },
  { name: 'raw-s3', load: () => import('./adapters/raw-s3.mjs') },
  // A CONTROL, not a scored entry: Filelayer as it was before the delivery and
  // authorization rebuild. A suite that the implementation it was written
  // alongside passes perfectly is a suite a reader should distrust, so it is
  // calibrated against Filelayer's own previous artifact. Included in the
  // default run and labelled everywhere.
  {
    name: 'filelayer-prerebuild',
    control: true,
    load: () => import(PUBLISHED ? './adapters/filelayer-prerebuild.mjs?published' : './adapters/filelayer-prerebuild.mjs'),
  },
];

/**
 * The two implementations that have no executable form.
 *
 * They are NOT scored. Recording a guess here -- in either direction -- would
 * be exactly the dishonesty this suite exists to remove. Their reports are code
 * reviews and are labelled as such.
 */
const NOT_RUN = [
  {
    name: 'convex',
    why:
      'No executable form. The Convex baseline targets a hosted platform: `query`/`mutation` ' +
      'functions are executed by the Convex runtime and `@convex-dev/r2` is a hosted ' +
      'component. Running it requires a live deployment and an R2 bucket, which the ' +
      'benchmark rules do not permit (no network, no accounts). Its REPORT.md says so ' +
      'prominently and independently of this suite. It has also never been compiled: there is ' +
      'no tsconfig.json and no generated convex/_generated/ in the directory.',
  },
  {
    name: 'vercel-blob',
    why:
      'No executable form. 21 Next.js route handlers plus `@vercel/blob` against a private ' +
      'store; `issueSignedToken` and private-blob delivery have no local emulation, and ' +
      'faking one would test the fake. Its REPORT.md leads with this caveat. It has also never ' +
      'been compiled: there is no tsconfig.json in the directory.',
  },
];

const SYMBOL = { defended: 'PASS', BREACH: 'BREACH', partial: 'PART', 'audit-gap': 'GAP', 'n/a': 'n/a' };

async function runOne(adapterMod, attack) {
  let impl;
  try {
    impl = await adapterMod.create();
  } catch (e) {
    return { verdict: 'error', detail: `world setup failed: ${e.message}` };
  }
  try {
    const missing = (attack.requires ?? []).filter((cap) => typeof impl[cap] !== 'function');
    if (missing.length) {
      return { verdict: 'n/a', detail: `no ${missing.join('/')} surface in this implementation` };
    }
    return await attack.run(impl, impl.w);
  } catch (e) {
    return { verdict: 'error', detail: `${e.message}` };
  } finally {
    try {
      await impl?.close?.();
    } catch {
      /* best effort */
    }
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asMarkdown = process.argv.includes('--md');
const targets = ADAPTERS.filter((a) => only.length === 0 || only.includes(a.name));

const results = {}; // impl -> attackId -> {verdict, detail}
const notes = {}; // impl -> meta.note, so a result names what it ran against
for (const a of targets) {
  const mod = await a.load();
  results[a.name] = {};
  notes[a.name] = mod.meta?.note;
  for (const attack of ATTACKS) {
    const r = await runOne(mod, attack);
    results[a.name][attack.id] = r;
    if (!asMarkdown) {
      const tag = (SYMBOL[r.verdict] ?? r.verdict.toUpperCase()).padEnd(6);
      console.log(`${a.name.padEnd(10)} ${attack.id.padEnd(3)} ${tag} ${attack.name}`);
      if (r.verdict !== 'defended') console.log(`${' '.repeat(21)}-> ${r.detail}`);
    }
  }
}

const tally = (impl) => {
  const vs = Object.values(results[impl] ?? {});
  return {
    defended: vs.filter((v) => v.verdict === 'defended').length,
    partial: vs.filter((v) => v.verdict === 'partial').length,
    breach: vs.filter((v) => v.verdict === 'BREACH').length,
    gap: vs.filter((v) => v.verdict === 'audit-gap').length,
    na: vs.filter((v) => v.verdict === 'n/a').length,
    error: vs.filter((v) => v.verdict === 'error').length,
  };
};

if (asMarkdown) {
  const names = Object.keys(results);
  const out = [];
  out.push('# SHARED ADVERSARIAL SUITE — RESULTS');
  out.push('');
  out.push(
    `Generated by \`node benchmark/adversarial/run.mjs ${PUBLISHED ? '--published ' : ''}--md\`. ${ATTACKS.length} attacks,`,
  );
  out.push('written once in `attacks.mjs`, executed against every implementation that has an');
  out.push('executable form.');
  out.push('');
  if (notes.filelayer) {
    out.push(`\`filelayer\` here is ${notes.filelayer}.`);
    out.push('');
  }
  out.push('`n/a` means the implementation cannot express the attack. **It is not a pass.**');
  out.push('`GAP` (audit-gap) means nothing was disclosed or changed, but the application\'s own audit');
  out.push('trail does not record the refusal. Request logs outside the application may hold it;');
  out.push('the suite cannot read those and does not claim they are empty. It is not a breach.');
  out.push('');
  // The headline compares like with like: only the attacks that EVERY scored
  // implementation can express. An attack on a feature only one of them has
  // (per-file visibility, delegation, file-level expiry, a share listing) is
  // reported below, separately, and never added into that comparison.
  const scored = names.filter((n) => !CONTROL.has(n));
  const shared = ATTACKS.filter((attack) => scored.every((n) => results[n][attack.id].verdict !== 'n/a'));
  const partialSet = ATTACKS.filter((attack) => !shared.includes(attack));
  const row = (attack) => {
    const cells = names.map((n) => SYMBOL[results[n][attack.id].verdict] ?? 'ERR');
    return `| ${attack.id} | ${attack.name} | ${attack.severity} | ${cells.join(' | ')} |`;
  };
  const head = [`| # | Attack | Severity | ${names.join(' | ')} |`, `|---|---|---|${names.map(() => '---').join('|')}|`];
  const tallyOn = (n, set) => {
    const vs = set.map((a) => results[n][a.id].verdict);
    const c = (v) => vs.filter((x) => x === v).length;
    return { defended: c('defended'), partial: c('partial'), gap: c('audit-gap'), breach: c('BREACH'), na: c('n/a') };
  };
  out.push(`## The ${shared.length} attacks every executed implementation can express`);
  out.push('');
  out.push('| Implementation | defended | partial | audit-gap | BREACH |');
  out.push('|---|---:|---:|---:|---:|');
  for (const n of names) {
    const t = tallyOn(n, shared);
    const label = CONTROL.has(n) ? `${n} (control)` : n;
    out.push(`| ${label} | ${t.defended}/${shared.length} | ${t.partial} | ${t.gap} | ${t.breach} |`);
  }
  out.push('');
  out.push(...head);
  for (const attack of shared) out.push(row(attack));
  out.push('');
  out.push(`## The ${partialSet.length} attacks not every implementation can express`);
  out.push('');
  out.push('Reported apart, and not added into the comparison above. Most test a feature that');
  out.push('only some implementations have; the rest depend on whether the application serves');
  out.push('the bytes itself or redirects to a signed URL.');
  out.push('');
  out.push(head[0].replace('| Severity |', '| Severity | cannot express |'));
  out.push(head[1].replace('|---|---|---|', '|---|---|---|---|'));
  for (const attack of partialSet) {
    const missing = scored.filter((n) => results[n][attack.id].verdict === 'n/a').join(', ');
    const cells = names.map((n) => SYMBOL[results[n][attack.id].verdict] ?? 'ERR');
    out.push(`| ${attack.id} | ${attack.name} | ${attack.severity} | ${missing} | ${cells.join(' | ')} |`);
  }
  out.push('');
  out.push('## Tallies over every attack each implementation can express');
  out.push('');
  out.push('| Implementation | defended | partial | audit-gap | BREACH | n/a |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const n of names) {
    const t = tally(n);
    out.push(`| ${n} | ${t.defended} | ${t.partial} | ${t.gap} | ${t.breach} | ${t.na} |`);
  }
  out.push('');
  out.push('## Not run');
  out.push('');
  for (const nr of NOT_RUN) out.push(`- **${nr.name}** — ${nr.why}`);
  out.push('');
  out.push('## Every non-`PASS` verdict, in full');
  out.push('');
  for (const n of names) {
    out.push(`### ${n}`);
    out.push('');
    let any = false;
    for (const attack of ATTACKS) {
      const r = results[n][attack.id];
      if (r.verdict === 'defended') continue;
      any = true;
      out.push(`- **${attack.id} ${attack.name}** — \`${r.verdict}\`: ${r.detail}`);
    }
    if (!any) out.push('_(every attack defended)_');
    out.push('');
  }
  console.log(out.join('\n'));
} else {
  console.log('\n=== TALLY ===');
  for (const n of Object.keys(results)) {
    const t = tally(n);
    console.log(
      `${n.padEnd(10)} defended=${t.defended} partial=${t.partial} audit-gap=${t.gap} BREACH=${t.breach} n/a=${t.na} error=${t.error}`,
    );
  }
  console.log('\nnot run (no executable form):');
  for (const nr of NOT_RUN) console.log(`  ${nr.name}`);
}

const anyBreach = Object.keys(results).some((n) => tally(n).breach > 0);
if (anyBreach) process.exitCode = 1;
