#!/usr/bin/env node
/**
 * THE METRICS OF EACH TASK OF EACH RUN, from the record alone.
 *
 *   node analyze.mjs --runs ../runs/pilot
 *
 * Reads run.json, task<N>.jsonl (the session's stream-json), the snapshot and
 * score.json, and writes runs/<phase>/<run>/metrics.json. Every figure carries
 * its label: observed (read from the record), or estimated (computed from
 * observed figures with the method written next to it).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTED_EXT, countFile } from '../../loc-count.mjs';
import { costOf, usageCounter } from './usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runsDir = resolve(args[args.indexOf('--runs') + 1]);
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}).filter(Boolean);

/** What the session did, tool call by tool call. */
function session(file) {
  const out = {
    toolCalls: {}, testRuns: 0, corrections: 0,
    docReads: { webFetch: 0, packageFiles: 0, packageFilesViaBash: 0, chars: 0 },
    // Cold review, finding 1: @filelayer/core ships examples/vault, close to a
    // solution of this very task. Every tool call that touches it is counted,
    // however it reads (Read, Grep, Glob, or a shell command), and so are the
    // package's other examples, apart.
    examples: { vault: 0, other: 0 },
  };
  const touches = (input) => JSON.stringify(input ?? {});
  const countExamples = (text) => {
    if (/examples\/vault/.test(text)) out.examples.vault++;
    else if (/@filelayer\/core\/examples\/|node_modules\/@filelayer\/core\/.*examples\//.test(text)) out.examples.other++;
  };
  const written = new Set();
  let ranOnce = false;
  const pending = new Map();
  for (const m of lines(file)) {
    if (m.type === 'assistant') {
      for (const p of m.message?.content ?? []) {
        if (p.type !== 'tool_use') continue;
        out.toolCalls[p.name] = (out.toolCalls[p.name] ?? 0) + 1;
        const input = p.input ?? {};
        countExamples(touches(input));
        if (p.name === 'Bash') {
          const cmd = String(input.command ?? '');
          // Documentation read through the shell: any command over a file
          // under node_modules.
          if (/node_modules\//.test(cmd) && /\b(cat|head|tail|less|more|sed|awk|grep|rg|find|ls)\b/.test(cmd)) {
            out.docReads.packageFilesViaBash++;
            pending.set(p.id, 'doc');
          }
          // A run of the service or of a test: the smoke test, npm test or
          // start, node --test, or a request to the running service.
          if (/smoke\.mjs|npm (run )?test|node --test|npm start|curl .*127\.0\.0\.1|curl .*localhost/.test(cmd)) {
            out.testRuns++;
            ranOnce = true;
          }
        }
        if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(p.name)) {
          const f = input.file_path ?? input.notebook_path;
          // A correction: a change to a file already written, after the first
          // time the service or a test was run.
          if (f && written.has(f) && ranOnce) out.corrections++;
          if (f) written.add(f);
        }
        if (p.name === 'WebFetch') {
          out.docReads.webFetch++;
          pending.set(p.id, 'doc');
        }
        if (['Read', 'Grep', 'Glob'].includes(p.name) && /node_modules\//.test(touches(input))) {
          out.docReads.packageFiles++;
          pending.set(p.id, 'doc');
        }
      }
    }
    if (m.type === 'user') {
      for (const p of m.message?.content ?? []) {
        if (p.type === 'tool_result' && pending.get(p.tool_use_id) === 'doc') {
          const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? '');
          out.docReads.chars += c.length;
        }
      }
    }
  }
  return out;
}

function loc(dir) {
  let gross = 0;
  let net = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (COUNTED_EXT.has(extname(e.name)) && !/package-lock\.json$/.test(e.name)) {
        const c = countFile(p);
        gross += c.gross;
        net += c.net;
        files++;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, gross, net };
}

function dependencies(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { runtime: Object.keys(p.dependencies ?? {}).sort(), dev: Object.keys(p.devDependencies ?? {}).sort() };
  } catch {
    return null;
  }
}

/** Lines the task itself changed, from the snapshot's git history. */
function diff(dir) {
  try {
    const s = execFileSync('git', ['-C', dir, 'diff', '--shortstat', 'HEAD~1', 'HEAD', '--', '.', ':!package-lock.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const n = (re) => Number(s.match(re)?.[1] ?? 0);
    return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), removed: n(/(\d+) deletions?/) };
  } catch {
    return null;
  }
}


// --- invalidity ---------------------------------------------------------------
//
// A run is invalid when the infrastructure failed, never because of what the
// agent did, and the rules look only at the infrastructure's own records,
// never at the outcome (PREREG.md, "Runs"). Any invalid task makes the whole
// run invalid; it is published with its reason and replaced once.

const API_FAILURE = /API Error:?\s*(5\d\d|429)|overloaded|rate[_ ]?limit|Internal server error|Connection error|ECONNRESET|socket hang up|fetch failed/i;

function egressFailures(file, from, to) {
  if (!existsSync(file) || !from || !to) return [];
  const a = Date.parse(from);
  const b = Date.parse(to);
  return lines(file).filter((e) => e.allowed === true && e.error && Date.parse(e.t) >= a && Date.parse(e.t) <= b);
}

function invalidity(run, t, score, base) {
  if (run.invalid) return run.invalid.reason;
  if (run.error) return 'harness_error';
  if (t.skipped) return null;
  const r = t.claude;
  // The session ended because the API failed: an error result whose text is an
  // API failure, or no result at all and an API failure on stderr. A budget
  // stop is the agent's, not the API's.
  if (r?.subtype !== 'error_max_budget_usd' && r?.isError && API_FAILURE.test(r.resultText ?? '')) return 'api_failure';
  if (!r && t.stoppedBy?.startsWith('exit_') && API_FAILURE.test(t.stderrTail ?? '')) return 'api_failure';
  // An allowed host that could not be reached during the session.
  const egress = egressFailures(join(base, 'egress.jsonl'), t.startedAt, t.endedAt);
  if (egress.length) return `egress_failure (${[...new Set(egress.map((e) => e.host))].join(', ')})`;
  if (score?.scorerError) return `scorer_failure (${score.scorerError})`;
  return null;
}

for (const d of readdirSync(runsDir, { withFileTypes: true })) {
  const runFile = join(runsDir, d.name, 'run.json');
  if (!d.isDirectory() || !existsSync(runFile)) continue;
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const tasks = [];
  for (const t of run.tasks) {
    const base = join(runsDir, d.name);
    const scoreFile = join(base, `task${t.task}`, 'score.json');
    const score = existsSync(scoreFile) ? JSON.parse(readFileSync(scoreFile, 'utf8')) : null;
    // Claude Code's own total when the session ended normally; otherwise the
    // sum of the stream's messages, so a session the harness stopped keeps the
    // tokens it spent (cold review, finding 2).
    const streamFile = join(base, `task${t.task}.jsonl`);
    const fromStream = () => {
      if (t.streamUsage) return t.streamUsage;
      if (!existsSync(streamFile)) return null;
      const c = usageCounter();
      for (const m of lines(streamFile)) c.add(m);
      return c.turns ? c.usage : null;
    };
    const u = t.claude?.usage ?? fromStream();
    const tokensSource = t.claude?.usage ? 'result' : u ? 'stream' : null;
    const app = join(base, `task${t.task}`, 'app');
    const extra = score?.[`task${t.task}`];
    const functionalAll = score?.functional ? score.functional.allPassed : false;
    const withinLimits = ['finished'].includes(t.stoppedBy);
    tasks.push({
      task: t.task,
      invalid: invalidity(run, t, score, base),
      stoppedBy: t.stoppedBy,
      declaredDone: t.declaredDone ?? false,
      observed: {
        wallMs: t.wallMs ?? null,
        turns: t.claude?.numTurns ?? t.turnsSeen ?? null,
        tokens: u ? {
          input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
          inputPlusOutput: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
        } : null,
        tokensSource,
        claudeCodeCostUsd: t.claude?.totalCostUsd ?? null,
        ...(existsSync(join(base, `task${t.task}.jsonl`)) ? session(join(base, `task${t.task}.jsonl`)) : {}),
        loc: loc(app),
        diff: diff(app),
        dependencies: dependencies(app),
        functional: score?.functional ? { passed: score.functional.passed, of: score.functional.of, failed: score.functional.results.filter((r) => !r.pass).map((r) => r.id) } : null,
        taskChecks: extra ? { passed: extra.passed, of: extra.of, failed: extra.results.filter((r) => !r.pass).map((r) => r.id) } : null,
        // A project that is missing, does not install or does not start defends
        // nothing: 0 of 21, not a missing value (cold review, finding 7).
        security: score?.security
          ? { defended: score.security.defended, of: score.security.of, breached: score.security.results.filter((r) => r.scored && r.verdict !== 'defended').map((r) => r.id) }
          : score && !score.scorerError ? { defended: 0, of: 21, breached: 'all', reason: score.noProject ? 'no project' : score.installFailed ? 'npm install failed' : 'did not start' } : null,
        installFailed: score?.installFailed ?? false,
        late: score?.late ? { defended: score.late.defended, of: score.late.of } : null,
        // The three blocks. A task is complete only within its limits.
        blocks: {
          functional: withinLimits && functionalAll,
          security: withinLimits && !!score?.security?.allDefended,
          both: withinLimits && functionalAll && !!score?.security?.allDefended,
        },
      },
      estimated: {
        costUsd: costOf(cfg.prices, run.model, u),
        costMethod: 'tokens of each kind times the price of config.json for the model',
        docTokens: existsSync(streamFile) ? Math.round(session(streamFile).docReads.chars / 4) : null,
        docTokensMethod: 'characters of the results of WebFetch, and of Read, Grep, Glob and shell reads of files under node_modules, divided by 4',
      },
    });
  }
  const bad = tasks.find((t) => t.invalid);
  const metrics = {
    id: run.id, phase: run.phase, arm: run.arm, model: run.model, dryRun: run.dryRun, replaces: run.replaces ?? null,
    error: run.error ?? null,
    invalid: bad ? { task: bad.task, reason: bad.invalid } : null,
    tasks,
  };
  writeFileSync(join(runsDir, d.name, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(`${run.id}: ${tasks.map((t) => `t${t.task} ${t.stoppedBy} F${t.observed.blocks.functional ? '+' : '-'} S${t.observed.blocks.security ? '+' : '-'} loc ${t.observed.loc.net}`).join(' | ')}`);
}
