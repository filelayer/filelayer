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

// Claude Code's own error lines, anchored at the start of a line: never a bare
// number or word, which a warning or the agent's output could carry.
const LINE = /^\s*(API Error\b.*|Request timed out.*|Credit balance is too low.*|Invalid API key.*|Connection error.*)$/gim;
const KEY_EXHAUSTED = /^\s*(Credit balance is too low|API Error\b.*\b(credit balance|billing_error)\b)/i;
const AUTH = /^\s*(Invalid API key|API Error\b.*\b(401|403|authentication_error|permission_error)\b)/i;
const ERROR_START = /^\s*(API Error\b|Request timed out|Credit balance is too low|Invalid API key|Connection error)/i;
/** Lines of stderr that are Claude Code's API error lines; run.mjs times each. */
export const API_ERROR_LINES = /^\s*(API Error\b|Request timed out|Credit balance is too low|Invalid API key|Connection error)/gim;
// A session that ended for the agent's reason (finished, its budget, its turns)
// is never invalid by the API, whatever retries it went through (cold review of
// 1bba1d8, N-B1): only error, exit_* and wall stops are read below. Retried
// errors are frequent in long sessions, and dropping those would select on the
// outcome. A budget or turn subtype is the agent's whatever is_error says; a
// success subtype only when it is not an error, because Claude Code reports a
// failed API call as success with is_error true (cold review of d89b967, NI-1).
const AGENT_LIMITS = new Set(['error_max_budget_usd', 'error_max_turns']);
// How long without a single response before a wall-clock stop counts as the
// API having been down at the end.
export const WALL_SILENCE_MINUTES = 2;
// How close to the end of the session the last API error must be to say the
// API was what ended it (NI-2, NI-3).
export const RECENT_SECONDS = 60;

const kind = (line) => (KEY_EXHAUSTED.test(line) ? 'api_key_exhausted' : AUTH.test(line) ? 'api_auth' : 'api_failure');

/**
 * null, or 'api_key_exhausted' | 'api_auth' | 'api_failure'.
 *
 * API evidence counts only when the session did not end for the agent's own
 * reason, and only API errors after the last response the session got count:
 * an error that a retry got past is history, not the cause of the end.
 *   - `error` or `exit_*`: at least one such error, the last within
 *     RECENT_SECONDS of the end. An error result whose text is one of Claude
 *     Code's error lines is an error at the end;
 *   - `wall`: the API was still failing at the end: at least two such errors,
 *     the last within RECENT_SECONDS of the end, and no response for
 *     WALL_SILENCE_MINUTES before the stop;
 *   - `finished`, `budget`, `turns`: never.
 * The kind is read from the last error line.
 */
export function apiFailure(t) {
  const stop = t?.stoppedBy ?? '';
  const r = t?.claude;
  if (r && (AGENT_LIMITS.has(r.subtype) || (r.subtype === 'success' && !r.isError))) return null;
  if (!(stop === 'error' || stop.startsWith('exit_') || stop === 'wall')) return null;
  const lines = [...String(t?.stderrTail ?? '').matchAll(LINE)].map((m) => m[1]);
  const end = Date.parse(t.endedAt ?? 0);
  const last = Date.parse(t.lastResponseAt ?? t.startedAt ?? 0) || 0;
  const times = (t.apiErrorTimes ?? (t.lastApiErrorAt ? [t.lastApiErrorAt] : [])).map((x) => Date.parse(x)).filter((x) => x > last);
  if (r?.isError && ERROR_START.test(r.resultText ?? '')) {
    lines.push(String(r.resultText).trim().split('\n')[0]);
    times.push(end);
  }
  if (!lines.length || !times.length) return null;
  const recent = end - Math.max(...times) <= RECENT_SECONDS * 1000;
  if (!recent) return null;
  if (stop === 'wall') {
    if (times.length < 2 || end - last < WALL_SILENCE_MINUTES * 60_000) return null;
  }
  return kind(lines.at(-1));
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
export function egressInWindow(entries, from, to, persistentMinutes, essential = ['api.anthropic.com', 'registry.npmjs.org']) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const inside = entries.filter((e) => e.allowed === true && e.host && Date.parse(e.t) >= a && Date.parse(e.t) <= b)
    .sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  const errors = {};
  const persistent = [];
  for (const host of new Set(inside.filter((e) => e.error).map((e) => e.host))) {
    const mine = inside.filter((e) => e.host === host);
    const failed = mine.filter((e) => e.error);
    errors[host] = failed.length;
    // Only the hosts a run cannot do without can invalidate it (cold review of
    // 1bba1d8, N-I1). A documentation site that failed is recorded, and it is
    // the agent's problem as much as a page that was hard to read.
    if (!essential.includes(host)) continue;
    // At least two failed attempts, so that one error never decides (N-N2).
    if (failed.length < 2) continue;
    if (!mine.some((e) => e.connected)) {
      persistent.push(`${host}: no successful connection in the session`);
      continue;
    }
    let streak = [];
    for (const e of mine) {
      if (e.connected) streak = [];
      else if (e.error) {
        // A streak is continuous trying: a gap of more than 2 minutes with no
        // attempt at all starts a new one (N-N2).
        if (streak.length && Date.parse(e.t) - streak.at(-1) > 2 * 60_000) streak = [];
        streak.push(Date.parse(e.t));
        if (streak.length >= 2 && streak.at(-1) - streak[0] >= persistentMinutes * 60_000) {
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
  let shellInVault = false;
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
          // A cd into examples/vault (or into vault from the examples) leaves
          // the shell there, and the next command's reads are vault reads.
          const intoVault = (d, fromExamples) => /examples\/vault/.test(d) || (fromExamples && /^\.?\/?vault(\/|$)/.test(d));
          const contextVault = shellInVault || cds.some((d) => intoVault(d, shellInExamples));
          if (cds.length) {
            const last = cds.at(-1);
            const relative = !last.startsWith('/') && !last.startsWith('~') && !last.startsWith('..');
            shellInVault = intoVault(last, shellInExamples) || (shellInVault && relative);
            shellInExamples = inExamples(last) || (shellInExamples && relative);
          }
          // A command that only changes directory reads nothing.
          if (!cmd.replace(/(?:^|[;&|]\s*)cd\s+[^\s;&|]+/g, '').replace(/[;&|\s]+/g, '')) continue;
          if ((/vault/.test(cmd) && (inExamples(cmd) || contextExamples)) || contextVault) count(p.id, 'vault');
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
