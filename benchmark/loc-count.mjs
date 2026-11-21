/**
 * How a line is counted: GROSS is every line, NET a line that is neither
 * blank nor comment-only. Taken out of count-loc.mjs unchanged, so that
 * count-loc.mjs and productivity/harness/analyze.mjs count the same way.
 */
import fs from 'node:fs';
import path from 'node:path';

export const COUNTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.sql', '.json', '.yaml', '.yml', '.toml',
]);

/**
 * Comment syntax per language. `--` for SQL is the line the old script could
 * not see, and it is 364 of Supabase's 564 lines.
 */
export function commentSyntax(ext) {
  switch (ext) {
    case '.sql':
      return { line: ['--'], block: ['/*', '*/'] };
    case '.yaml':
    case '.yml':
    case '.toml':
      return { line: ['#'], block: null };
    case '.json':
      // JSON has no comments, so infrastructure files carry them as a
      // `"_comment"` key. That text is prose, not configuration, and counting
      // it as infrastructure charged an implementation for explaining itself
      // (review of 2026-11-13). Handled in countFile.
      return { line: [], block: null, jsonComment: true };
    default:
      return { line: ['//'], block: ['/*', '*/'] };
  }
}

export function countFile(abs) {
  const ext = path.extname(abs);
  const { line, block } = commentSyntax(ext);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let net = 0;
  let inBlock = false;
  let inJsonComment = false;
  const jsonComment = commentSyntax(ext).jsonComment === true;
  for (const raw of lines) {
    const t = raw.trim();
    // A `"_comment": "..."` line, or every line of a `"_comment": [ ... ]`
    // array up to and including its closing bracket.
    if (jsonComment) {
      if (inJsonComment) {
        if (/^\]\s*,?$/.test(t)) inJsonComment = false;
        continue;
      }
      if (/^"_comment"\s*:/.test(t)) {
        if (/^"_comment"\s*:\s*\[/.test(t) && !/\]\s*,?$/.test(t)) inJsonComment = true;
        continue;
      }
    }
    if (inBlock) {
      if (block && t.includes(block[1])) inBlock = false;
      continue;
    }
    if (t === '') continue;
    if (line.some((p) => t.startsWith(p))) continue;
    if (block && t.startsWith(block[0])) {
      if (!t.includes(block[1])) inBlock = true;
      continue;
    }
    // A continuation line of a block comment written in the `*` style.
    if (block && t.startsWith('*')) continue;
    net++;
  }
  return { gross: lines.length, net };
}
