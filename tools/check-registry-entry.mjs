#!/usr/bin/env node
/**
 * Keep `server.json` -- the MCP registry entry -- true about this package.
 *
 *     node tools/check-registry-entry.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The entry restates things that live elsewhere: a version in two places, the
 * package name, the server name, and the exact argv a client will run. None of
 * it is generated, so all of it can go stale, and a stale registry entry is the
 * worst kind of stale document in this project -- a client reads it and tries
 * to start something.
 *
 * The ownership rule makes one of these load-bearing. The registry proves we
 * own `@filelayer/core` by reading `mcpName` out of the PUBLISHED package and
 * comparing it to the server name. If those two ever disagree, publishing the
 * entry fails with a verification error, and the obvious place to look is not
 * `package.json`.
 *
 * What is NOT checked here: whether the argv actually starts the server. That
 * is `check:published`, which installs from the registry and runs the command
 * out of the README. This file checks that the registry entry says the same
 * thing the README does -- two documents, one claim.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const fail = (what, detail) => {
  failures++;
  console.error(`  FAIL  ${what}\n        ${detail}`);
};

const read = (rel) => {
  // An absent file must explain itself. `server.json` is at the top level of a
  // repository whose .gitignore is an allow-list, so a new file there is
  // invisible to a clean checkout until it is allowed -- which is exactly what
  // happened on its first commit: it synced to the internal mirror and CI saw
  // nothing. A stack trace from readFileSync would have told whoever read the
  // CI log almost nothing.
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch (e) {
    console.error(
      `check-registry-entry: could not read ${rel}: ${String(e.message).slice(0, 140)}\n\n` +
        '  If it exists locally but not here, check .gitignore: the top level of this\n' +
        '  repository is an allow-list, and a file that is not listed is not committed.\n' +
        `  \`git check-ignore -v ${rel}\` names the rule.`,
    );
    process.exit(2);
  }
};

const server = read('server.json');
const pkg = read('packages/core/package.json');

// --- the schema's own limits -----------------------------------------------
//
// Read out of server.schema.json rather than inferred from the examples, which
// is how this was missed: the first entry had a 380-character description, the
// documentation's examples all have short ones and say nothing about a limit,
// and the registry rejected the publish with a 422 after the DNS record was
// already in place. A constraint that only the remote end enforces is one you
// discover at the worst moment.
//
// From https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
const LIMITS = [
  { field: 'description', max: 100, min: 1 },
  { field: 'title', max: 100, min: 1 },
  { field: 'version', max: 255, min: 1 },
  { field: 'name', max: 200, min: 3, pattern: /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/ },
];
for (const { field, max, min, pattern } of LIMITS) {
  const v = server[field];
  if (typeof v !== 'string') {
    fail(`server.json has no ${field}`, 'The registry requires it.');
    continue;
  }
  if (v.length > max || v.length < min) {
    fail(
      `server.json ${field} is ${v.length} characters; the schema allows ${min}-${max}`,
      `The registry rejects the publish with a 422, and it does so AFTER the DNS\n` +
        `        record is in place, so the cost of finding this remotely is not zero.\n` +
        `        Value: ${JSON.stringify(v.slice(0, 120))}${v.length > 120 ? '…' : ''}`,
    );
  }
  if (pattern && !pattern.test(v)) {
    fail(`server.json ${field} does not match the schema's pattern`, `${pattern} vs ${JSON.stringify(v)}`);
  }
}

// --- the ownership marker --------------------------------------------------
if (pkg.mcpName !== server.name) {
  fail(
    'the ownership marker and the server name disagree',
    `packages/core/package.json has mcpName=${JSON.stringify(pkg.mcpName)} and\n` +
      `        server.json has name=${JSON.stringify(server.name)}. The registry reads the\n` +
      '        first out of the published package to prove we own it and compares it to the\n' +
      '        second; a mismatch fails publishing with a verification error that points at\n' +
      '        neither file.',
  );
}

// --- the versions ----------------------------------------------------------
const npmPkg = (server.packages ?? []).find((p) => p.registryType === 'npm');
if (!npmPkg) {
  fail('server.json declares no npm package', 'Nothing here can be verified against this repository.');
} else {
  if (npmPkg.identifier !== pkg.name) {
    fail(
      'server.json points at a different npm package',
      `It says ${JSON.stringify(npmPkg.identifier)}; this repository publishes ` +
        `${JSON.stringify(pkg.name)}.`,
    );
  }
  for (const [where, value] of [
    ['server.json version', server.version],
    ['server.json packages[npm].version', npmPkg.version],
  ]) {
    if (value !== pkg.version) {
      fail(
        `${where} is ${value}, and this package is ${pkg.version}`,
        'A registry entry naming a version that is not the current one sends a client\n' +
          '        to an older tarball than the documentation describes.',
      );
    }
  }

  // --- the argv, against the README -----------------------------------------
  //
  // The README's client configuration is the one a reader pastes, and
  // `check:published` proves THAT one starts the server. So the registry entry
  // has to agree with it rather than being a second guess at the same command.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const m = /"args":\s*(\[[^\]]*\])/.exec(readme);
  if (!m) {
    fail(
      'no client `args` array found in README.md',
      'This check compares the registry entry against it. If the block moved, teach\n' +
        '        this file the new location rather than leaving the two unlinked.',
    );
  } else {
    // The README's array is what a client passes to `npx`, including the `-y`
    // that npx itself consumes. The registry expresses the rest as
    // packageArguments on top of its own `npx` runtime hint.
    const readmeArgs = JSON.parse(m[1]).filter((a) => a !== '-y');
    const entryArgs = (npmPkg.packageArguments ?? []).map((a) => a.value);
    if (readmeArgs.join(' ') !== entryArgs.join(' ')) {
      fail(
        'the registry entry and the README would run different commands',
        `README (without npx's own -y): ${readmeArgs.join(' ')}\n` +
          `        server.json packageArguments:  ${entryArgs.join(' ')}\n` +
          '        Only the README one is executed by a gate, so a difference means the\n' +
          '        registry entry is the unverified one.',
      );
    }
  }

  if (npmPkg.runtimeHint !== 'npx') {
    fail(
      `runtimeHint is ${JSON.stringify(npmPkg.runtimeHint)}`,
      'The README documents an `npx` invocation; the entry should say the same.',
    );
  }
}

// --- the environment it documents ------------------------------------------
//
// The three variables the server REFUSES to start without must be marked
// required, or a client will offer a configuration form that cannot work.
const env = new Map((npmPkg?.environmentVariables ?? []).map((v) => [v.name, v]));
for (const name of ['DATABASE_URL', 'FILELAYER_AS', 'FILELAYER_ORG']) {
  const v = env.get(name);
  if (!v) {
    fail(`${name} is not documented in server.json`, 'The server refuses to start without it.');
  } else if (v.isRequired !== true) {
    fail(
      `${name} is not marked isRequired`,
      'The server refuses to start without it, so a client that treats it as optional\n' +
        '        offers a configuration that cannot work.',
    );
  }
}
if (env.get('DATABASE_URL') && env.get('DATABASE_URL').isSecret !== true) {
  fail(
    'DATABASE_URL is not marked isSecret',
    'It carries a password. A client that does not know that may log it or show it.',
  );
}

// Every variable the server actually reads should be documented, or a reader
// configuring from the registry entry alone cannot reach the behaviour.
const src = readFileSync(join(ROOT, 'packages/core/src/mcp-server.ts'), 'utf8');
const used = new Set(
  [...src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]|process\.env\.([A-Z0-9_]+)/g)].map(
    (x) => x[1] ?? x[2],
  ),
);
const undocumented = [...used].filter((n) => !env.has(n));
if (undocumented.length > 0) {
  fail(
    `the server reads ${undocumented.length} variable(s) that server.json does not document`,
    `${undocumented.join(', ')}. A client configuring from the entry alone cannot reach\n` +
      '        whatever they control.',
  );
}

if (failures > 0) {
  console.error(`\ncheck-registry-entry: ${failures} failure(s).`);
  process.exit(1);
}
console.log(
  `check-registry-entry: clean. server.json describes ${pkg.name}@${pkg.version} as ` +
    `${server.name}, with ${env.size} documented variable(s) and the same argv the README ` +
    'prints.',
);
