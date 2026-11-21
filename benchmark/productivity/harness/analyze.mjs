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
  const out = { toolCalls: {}, testRuns: 0, corrections: 0, docReads: { webFetch: 0, packageFiles: 0, chars: 0 } };
  const written = new Set();
  let ranOnce = false;
  const pending = new Map();
  for (const m of lines(file)) {
    if (m.type === 'assistant') {
      for (const p of m.message?.content ?? []) {
        if (p.type !== 'tool_use') continue;
        out.toolCalls[p.name] = (out.toolCalls[p.name] ?? 0) + 1;
        const input = p.input ?? {};
        if (p.name === 'Bash') {
          const cmd = String(input.command ?? '');
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
        if (p.name === 'Read' && /node_modules\//.test(String(input.file_path ?? ''))) {
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
      { encoding: 'utf8' });
    const n = (re) => Number(s.match(re)?.[1] ?? 0);
    return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), removed: n(/(\d+) deletions?/) };
  } catch {
    return null;
  }
}

function cost(model, u) {
  const p = cfg.prices[model];
  if (!p || !u) return null;
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
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
    const u = t.claude?.usage ?? null;
    const app = join(base, `task${t.task}`, 'app');
    const extra = score?.[`task${t.task}`];
    const functionalAll = score?.functional ? score.functional.allPassed : false;
    const withinLimits = ['finished'].includes(t.stoppedBy);
    tasks.push({
      task: t.task,
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
        claudeCodeCostUsd: t.claude?.totalCostUsd ?? null,
        ...(existsSync(join(base, `task${t.task}.jsonl`)) ? session(join(base, `task${t.task}.jsonl`)) : {}),
        loc: loc(app),
        diff: diff(app),
        dependencies: dependencies(app),
        functional: score?.functional ? { passed: score.functional.passed, of: score.functional.of, failed: score.functional.results.filter((r) => !r.pass).map((r) => r.id) } : null,
        taskChecks: extra ? { passed: extra.passed, of: extra.of, failed: extra.results.filter((r) => !r.pass).map((r) => r.id) } : null,
        security: score?.security ? { defended: score.security.defended, of: score.security.of, breached: score.security.results.filter((r) => r.scored && r.verdict !== 'defended').map((r) => r.id) } : null,
        installFailed: score?.installFailed ?? false,
        // The three blocks. A task is complete only within its limits.
        blocks: {
          functional: withinLimits && functionalAll,
          security: withinLimits && !!score?.security?.allDefended,
          both: withinLimits && functionalAll && !!score?.security?.allDefended,
        },
      },
      estimated: {
        costUsd: cost(run.model, u),
        costMethod: 'tokens of each kind times the price of config.json for the model',
        docTokens: t.claude ? Math.round((session(join(base, `task${t.task}.jsonl`)).docReads.chars) / 4) : null,
        docTokensMethod: 'characters of WebFetch results and of files read under node_modules, divided by 4',
      },
    });
  }
  const metrics = { id: run.id, phase: run.phase, arm: run.arm, model: run.model, dryRun: run.dryRun, error: run.error ?? null, tasks };
  writeFileSync(join(runsDir, d.name, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(`${run.id}: ${tasks.map((t) => `t${t.task} ${t.stoppedBy} F${t.observed.blocks.functional ? '+' : '-'} S${t.observed.blocks.security ? '+' : '-'} loc ${t.observed.loc.net}`).join(' | ')}`);
}
