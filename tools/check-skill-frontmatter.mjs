#!/usr/bin/env node
/**
 * Hold the shipped skill inside the limits the skill LOADER enforces.
 *
 *     node tools/check-skill-frontmatter.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The Agent Skills specification caps `name` at 64 characters and
 * `description` at 1024, requires the name to match its directory, and
 * requires the description to be non-empty.
 *
 * Every one of those is enforced somewhere we cannot see. That is the same
 * shape as the registry's 100-character description limit, which this project
 * discovered by having a publish rejected with a 422 after the DNS record was
 * already in place -- a constraint only the remote end enforces is one you
 * meet at the worst possible moment.
 *
 * This one is worse than a 422, though, and that is the actual reason this
 * file exists. A 422 is loud. A skill whose frontmatter does not parse, or
 * whose description is empty, still LOADS -- it just loads with no description,
 * which means it silently loses every trigger it had. The skill would be in the
 * tarball, in the repository, in the documentation, and dead. Nothing in this
 * project's 27 other gates would have said a word, because they all check that
 * the skill is PRESENT and that its text is TRUE, and presence and truth are
 * not the same property as loadability.
 *
 * So: the description is the whole of the loading decision, it is the one field
 * with a hard remote limit, and today it sits at 90% of that limit. The next
 * person to add a clause to it should be told by a gate, not by a measurement
 * that mysteriously stops firing.
 *
 * What this does NOT check: whether the description is any GOOD. That is
 * measured, not asserted -- see evals/MEASUREMENT.md. This file only checks
 * that a loader will accept it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');

// From the Agent Skills specification. Encoded here rather than inferred from
// the skills that happen to exist, which is how the registry limit was missed.
const LIMITS = {
  name: { max: 64, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ },
  description: { max: 1024, min: 1 },
};

// Fields the specification defines. An unknown key is reported rather than
// ignored: a typo'd `descripton:` leaves the real field absent, and the
// failure mode of an absent description is silence.
const KNOWN = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

let failures = 0;
const fail = (what, detail) => {
  failures++;
  console.error(`  FAIL  ${what}\n        ${detail}`);
};

// Discovery is over what git TRACKS, not over what directories exist, and the
// difference is load-bearing. `skills/` also holds the evaluation workspace --
// grading runs, draft answers, trigger sets -- which is internal, untracked,
// and correctly has no SKILL.md. Scanning directories made this gate fail on
// it, and the tempting fix (skip any directory without a SKILL.md) is wrong in
// the one case that matters: deleting a SKILL.md would then make the gate pass.
//
// What ships is what git tracks, so that is the set to check. The workspace
// falls out by itself, and a deleted SKILL.md becomes a tracked directory with
// no skill in it, which is reported below.
let dirs;
try {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'skills/'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  dirs = [...new Set(tracked.map((p) => p.split('/')[1]).filter(Boolean))];
} catch (e) {
  console.error(
    `check-skill-frontmatter: could not list tracked files under skills/: ${e.message}\n\n` +
      '  This gate reads the tracked set rather than the directory listing, because\n' +
      '  skills/ also holds the untracked evaluation workspace. It needs a git checkout.',
  );
  process.exit(2);
}

if (dirs.length === 0) {
  // Not "nothing to do". This project ships a skill inside the npm tarball and
  // `check:copies` asserts the copy; zero skills here means something moved and
  // this gate just became vacuous, which is the failure it is most likely to
  // have. A gate that passes because it found nothing to check is the defect
  // this project keeps finding in its own tools.
  console.error(
    'check-skill-frontmatter: git tracks no files under skills/.\n\n' +
      '  This gate would pass by finding nothing, which is not the same as passing.\n' +
      '  Note that the top level of this repository is a .gitignore allow-list, so a\n' +
      '  skill that exists on disk but is not allowed is invisible here -- and would\n' +
      '  also be invisible to a clean checkout and to CI.',
  );
  process.exit(2);
}

const report = [];

for (const dir of dirs) {
  const path = join(SKILLS, dir, 'SKILL.md');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`skills/${dir} has no SKILL.md`, 'A skill directory without one is not a skill.');
    continue;
  }

  // The frontmatter must be the very first thing in the file. A loader that
  // does not find `---` on line 1 treats the whole file as body, and the skill
  // arrives with no name and no description.
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) {
    fail(
      `skills/${dir}/SKILL.md has no YAML frontmatter at the top of the file`,
      'It must open with `---` on the first line. Without it the skill still loads,\n' +
        '        with no description, and therefore never triggers.',
    );
    continue;
  }

  // Deliberately a strict line parser rather than a YAML library: the fields
  // here are flat scalars, and anything this cannot parse is something a
  // reader would also misread. Unparseable is a failure, never a skip.
  const fields = new Map();
  for (const raw of m[1].split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(raw);
    if (!kv) {
      fail(
        `skills/${dir}: frontmatter line is not a simple \`key: value\``,
        `${JSON.stringify(raw.slice(0, 80))}\n` +
          '        This gate parses flat scalars on purpose. If the frontmatter now needs\n' +
          '        block scalars or nesting, teach this file to parse them rather than\n' +
          '        loosening it -- a line it skips is a line nothing checks.',
      );
      continue;
    }
    const [, key, value] = kv;
    if (fields.has(key)) {
      fail(
        `skills/${dir}: frontmatter defines \`${key}\` twice`,
        'YAML keeps the last one. Two descriptions means one of them is a decoy that\n' +
          '        someone will keep editing with no effect.',
      );
    }
    fields.set(key, value.trim());
    if (!KNOWN.has(key)) {
      fail(
        `skills/${dir}: unknown frontmatter key \`${key}\``,
        'If this is a typo for a real field, the real field is absent and the loader\n' +
          `        is silent about it. Known keys: ${[...KNOWN].join(', ')}.`,
      );
    }
  }

  for (const field of ['name', 'description']) {
    if (!fields.has(field)) {
      fail(`skills/${dir}: frontmatter has no \`${field}\``, 'The specification requires it.');
    }
  }

  const name = fields.get('name');
  if (name !== undefined) {
    if (name.length > LIMITS.name.max) {
      fail(
        `skills/${dir}: name is ${name.length} characters; the limit is ${LIMITS.name.max}`,
        JSON.stringify(name),
      );
    }
    if (!LIMITS.name.pattern.test(name)) {
      fail(
        `skills/${dir}: name is not lowercase-with-single-hyphens`,
        `${LIMITS.name.pattern} vs ${JSON.stringify(name)}. No leading, trailing or\n` +
          '        doubled hyphens, no capitals, no underscores.',
      );
    }
    if (name !== basename(dir)) {
      fail(
        `skills/${dir}: name does not match its directory`,
        `The directory is ${JSON.stringify(basename(dir))} and the name is ` +
          `${JSON.stringify(name)}.\n        The specification requires them to agree.`,
      );
    }
  }

  const description = fields.get('description');
  if (description !== undefined) {
    const n = description.length;
    if (n < LIMITS.description.min) {
      fail(
        `skills/${dir}: description is empty`,
        'The description is the whole of the loading decision. An empty one does not\n' +
          '        fail to load; it loads and never triggers.',
      );
    } else if (n > LIMITS.description.max) {
      fail(
        `skills/${dir}: description is ${n} characters; the limit is ${LIMITS.description.max}`,
        `Over by ${n - LIMITS.description.max}. Nothing local rejects this -- the loader\n` +
          '        does, quietly, and the symptom is a skill that stops being selected.\n' +
          `        Ends: …${JSON.stringify(description.slice(-70))}`,
      );
    }
    // Quoted scalars are legal YAML but the quotes are not part of the value,
    // and a description measured WITH them is measured wrong -- which matters
    // here because two characters are enough to change whether this passes.
    if (/^['"][\s\S]*['"]$/.test(description)) {
      report.push(`skills/${dir}: description is quoted; ${n} counts the quotes, the value is ${n - 2}`);
    }
    report.push(
      `skills/${dir}: ${n}/${LIMITS.description.max} characters, ` +
        `${LIMITS.description.max - n} to spare`,
    );
  }
}

if (failures > 0) {
  console.error(`\ncheck-skill-frontmatter: ${failures} failure(s).`);
  process.exit(1);
}
console.log(
  `check-skill-frontmatter: clean. ${dirs.length} skill(s) within the loader's limits.\n  ` +
    report.join('\n  '),
);
