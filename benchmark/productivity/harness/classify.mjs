/**
 * WAS IT THE API? Shared by run.mjs (to stop a phase whose key is exhausted)
 * and analyze.mjs (to mark a task invalid).
 *
 * Read only from structured places, never from what the agent wrote: the
 * session's stderr, which is Claude Code's own, and the final result's text
 * only when the result says it is an error (is_error, and not a budget or turn
 * stop) and the text starts the way Claude Code's error messages do. An agent
 * that writes "rate limit" in its own summary is not an API failure.
 *
 * The exact texts of Claude Code 2.1.330 are checked in the pilot's records;
 * a pattern that turns out wrong there is a deviation, fixed before the full
 * phase.
 */

const KEY_EXHAUSTED = /credit balance is too low|spend(ing)? limit (has been )?reached|usage limit (has been )?reached|insufficient (credit|funds|balance)|billing/i;
const AUTH = /\b(401|403)\b|authentication_error|permission_error|invalid x-api-key|invalid api key/i;
const TRANSIENT = /\b(5\d\d)\b|overloaded|rate_limit_error|\b429\b|request timed out|timed out|internal server error|connection error|ECONNRESET|socket hang up|fetch failed/i;
const ERROR_START = /^\s*(API Error|Error:|Request timed out|Credit balance|Invalid API key|Connection error)/i;
const AGENT_STOPS = new Set(['error_max_budget_usd', 'error_max_turns']);

/** null, or 'api_key_exhausted' | 'api_auth' | 'api_failure'. */
export function apiFailure(t) {
  const sources = [];
  if (t?.stderrTail) sources.push(t.stderrTail);
  const r = t?.claude;
  if (r?.isError && !AGENT_STOPS.has(r.subtype) && ERROR_START.test(r.resultText ?? '')) sources.push(r.resultText);
  const text = sources.join('\n');
  if (!text) return null;
  if (KEY_EXHAUSTED.test(text)) return 'api_key_exhausted';
  if (AUTH.test(text)) return 'api_auth';
  if (TRANSIENT.test(text)) return 'api_failure';
  return null;
}

/** A failure after which no further run can succeed: the phase stops. */
export const STOPS_THE_PHASE = new Set(['api_key_exhausted', 'api_auth']);

/**
 * The egress record of one session's window. Every error to an allowed host
 * is counted and reported, by host; only a PERSISTENT failure invalidates
 * (cold review, B2): a host with no successful connection in the window, or a
 * run of errors lasting at least config.egress.persistentMinutes with no
 * success between them. A single error that a retry got past says nothing
 * about the infrastructure, and invalidating on it would drop long sessions
 * more often than short ones.
 */
export function egressInWindow(entries, from, to, persistentMinutes) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const inside = entries.filter((e) => e.allowed === true && e.host && Date.parse(e.t) >= a && Date.parse(e.t) <= b)
    .sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  const errors = {};
  const persistent = [];
  for (const host of new Set(inside.filter((e) => e.error).map((e) => e.host))) {
    const mine = inside.filter((e) => e.host === host);
    errors[host] = mine.filter((e) => e.error).length;
    if (!mine.some((e) => e.connected)) {
      persistent.push(`${host}: no successful connection in the session`);
      continue;
    }
    let streakStart = null;
    for (const e of mine) {
      if (e.connected) streakStart = null;
      else if (e.error) {
        streakStart ??= Date.parse(e.t);
        if (Date.parse(e.t) - streakStart >= persistentMinutes * 60_000) {
          persistent.push(`${host}: failing for ${persistentMinutes} minutes without a success`);
          break;
        }
      }
    }
  }
  return { errors, persistent };
}


/**
 * HOW OFTEN A SESSION READ THE PACKAGE'S EXAMPLES, examples/vault apart (cold
 * review of the benchmark, finding 1, and of its delta, I5).
 *
 * A tool call counts once, as a read of examples/vault, when either:
 *   - what it asked for names vault in the examples: a path, pattern or glob
 *     of Read, Grep or Glob, taken together, or a shell command, with
 *     `examples` in it or in the directory an earlier `cd` left the shell in;
 *   - or what it got back lists a file under examples/vault (a Grep over the
 *     whole package, a Glob, an `ls`).
 * Any other call that touches the package's examples counts as `other`.
 */
export function examplesReads(messages) {
  const out = { vault: 0, other: 0 };
  const calls = new Map(); // tool_use id -> { counted: 'vault' | 'other' | null }
  let shellInExamples = false;
  const inExamples = (s) => /(^|[/\s'"])examples(\/|\b)/.test(s);
  const count = (id, kind) => {
    const c = calls.get(id) ?? { counted: null };
    if (c.counted === 'vault' || c.counted === kind) return;
    if (kind === 'vault' && c.counted === 'other') out.other--;
    out[kind]++;
    c.counted = kind;
    calls.set(id, c);
  };
  for (const m of messages) {
    if (m?.type === 'assistant') {
      for (const p of m.message?.content ?? []) {
        if (p.type !== 'tool_use') continue;
        calls.set(p.id, { counted: null });
        const input = p.input ?? {};
        if (p.name === 'Bash') {
          const cmd = String(input.command ?? '');
          // Where the shell is after this command, for the next one.
          const cds = [...cmd.matchAll(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/g)].map((x) => x[1]);
          const contextExamples = shellInExamples || cds.some(inExamples);
          if (cds.length) shellInExamples = inExamples(cds.at(-1));
          // A command that only changes directory reads nothing.
          if (!cmd.replace(/(?:^|[;&|]\s*)cd\s+[^\s;&|]+/g, '').replace(/[;&|\s]+/g, '')) continue;
          if (/vault/.test(cmd) && (inExamples(cmd) || contextExamples)) count(p.id, 'vault');
          else if (inExamples(cmd) && /@filelayer\/core|node_modules/.test(cmd + (contextExamples ? ' node_modules' : ''))) count(p.id, 'other');
          continue;
        }
        if (['Read', 'Grep', 'Glob'].includes(p.name)) {
          const text = [input.file_path, input.path, input.pattern, input.glob].filter(Boolean).join(' ');
          if (/vault/.test(text) && inExamples(text)) count(p.id, 'vault');
          else if (inExamples(text) && /@filelayer\/core|node_modules/.test(text)) count(p.id, 'other');
        }
      }
    }
    if (m?.type === 'user') {
      for (const p of m.message?.content ?? []) {
        if (p.type !== 'tool_result' || !calls.has(p.tool_use_id)) continue;
        const body = typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? '');
        if (/examples\/vault\//.test(body)) count(p.tool_use_id, 'vault');
      }
    }
  }
  return out;
}
