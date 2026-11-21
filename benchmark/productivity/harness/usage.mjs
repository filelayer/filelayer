/**
 * TOKENS AND COST FROM THE SESSION'S OWN STREAM.
 *
 * Claude Code's final `result` message carries the session's total usage and
 * cost, but a session the harness stops (its clock, its turns) or that dies
 * never writes one. Its tokens were still spent. So the harness and the
 * analysis also add up the usage of every assistant message in the stream,
 * once per message id (one API response arrives as several stream lines that
 * repeat its usage), and use that sum wherever there is no result.
 *
 * Shared by run.mjs (live, for the phase cap and the turn limit) and
 * analyze.mjs (from the recorded stream), so both count the same way.
 */

const KINDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

export function usageCounter() {
  const byId = new Map();
  let anonymous = 0;
  return {
    /** Feed one parsed stream message. Returns true if it is a new turn. */
    add(m) {
      if (m?.type !== 'assistant') return false;
      const id = m.message?.id ?? `anonymous-${anonymous++}`;
      const fresh = !byId.has(id);
      if (m.message?.usage) byId.set(id, m.message.usage);
      else if (fresh) byId.set(id, null);
      return fresh;
    },
    get turns() {
      return byId.size;
    },
    get usage() {
      const total = Object.fromEntries(KINDS.map((k) => [k, 0]));
      for (const u of byId.values()) for (const k of KINDS) total[k] += u?.[k] ?? 0;
      return total;
    },
  };
}

/** Cost in USD of a usage object at the prices of config.json. */
export function costOf(prices, model, u) {
  const p = prices[model];
  if (!p || !u) return null;
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
}

/**
 * What a task cost, for the phase cap: the larger of Claude Code's own figure
 * and the estimate from the stream, so the cap never under-counts.
 */
export function taskSpend(prices, model, t) {
  const fromStream = costOf(prices, model, t?.streamUsage) ?? 0;
  return Math.max(t?.claude?.totalCostUsd ?? 0, fromStream);
}
