#!/usr/bin/env node
/**
 * THE GUIDES, SERVED WHERE THEY CAN BE FOUND.
 *
 *   node tools/build-guides.mjs           # write web/guides/ and web/sitemap.xml
 *   node tools/build-guides.mjs --check   # fail if what is committed is stale
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * On 5 October 2026 discovery was measured properly for the first time: the ten
 * questions a developer would actually type were put to a web search, and
 * Filelayer appeared in NONE of them. Not the homepage, not the README, not the
 * npm page, not a guide. The only string this project ranks for is its own
 * name, which means nothing finds it unless the reader already knew it existed.
 *
 * That is a worse finding than the staleness fixed the same morning, and it has
 * a structural cause rather than a content one. `filelayer.dev` was ONE
 * `index.html`, and `sitemap.xml` had one URL. Meanwhile four of those ten
 * questions already had careful, CI-verified answers written -- they were just
 * stored as markdown inside a source repository, where nothing searching for
 * the question can find them. Three of the four guide titles ARE the question,
 * word for word.
 *
 * So this generates nothing new. It serves what exists where it can be reached.
 * The instruction against low-quality SEO content is exactly right, and this is
 * the opposite of it: no page here says anything that was not already written,
 * reviewed, and executed by `npm run check:docs`.
 *
 * -----------------------------------------------------------------------------
 * THE ONE PROPERTY THAT MATTERS
 * -----------------------------------------------------------------------------
 *
 * The markdown in `docs/guides/` is the only source of truth. The HTML is
 * derived and is never edited. `--check` regenerates in memory and fails the
 * build if a single byte differs from what is committed.
 *
 * This is not a general precaution. The defect found hours before this file was
 * written was a hand-maintained copy of a fact on the homepage drifting three
 * releases behind the same fact in the trust table on the same page. A second
 * hand-written copy of a guide would be the same mistake with four times the
 * surface.
 *
 * -----------------------------------------------------------------------------
 * THE RENDERER REFUSES WHAT IT DOES NOT UNDERSTAND
 * -----------------------------------------------------------------------------
 *
 * Markdown renderers degrade gracefully: handed syntax they do not implement,
 * they emit the source text and carry on. That is the wrong failure mode here.
 * A guide whose table silently renders as a row of pipes, or whose link renders
 * as literal brackets, is a published page that misrepresents work we are
 * asking people to trust, and nobody would notice until a stranger did.
 *
 * So every block and every inline construct is explicitly recognised, and
 * anything else throws with a file and line number. `scripts` keeps zero root
 * dependencies, which is a property worth keeping, but the reason this is
 * hand-written rather than `marked` is not dependency count: it is that a
 * dependency would render the unknown construct quietly and this refuses to.
 * The corpus it must handle is bounded and measured -- h1 to h3, paragraphs,
 * fenced code, unordered and ordered lists, rules, tables, blockquotes, and
 * inline code, bold, emphasis and links -- and if a guide ever needs a
 * construct outside that set, the build stops and asks for it to be added.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(ROOT, 'docs', 'guides');
const OUT = join(ROOT, 'web', 'guides');
const SITE = 'https://filelayer.dev';
const CHECK = process.argv.includes('--check');

const VERSION = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).version;

/** Thrown with a location, because a renderer that refuses must say where. */
class Unsupported extends Error {
  constructor(file, line, what, text) {
    super(
      `${file}:${line} uses markdown this renderer does not implement: ${what}\n` +
        `      > ${text.trim().slice(0, 120)}\n` +
        '      Either rewrite the source in the supported subset, or add the construct to\n' +
        '      tools/build-guides.mjs. It is not rendered as literal text, because a page\n' +
        '      that silently misrepresents a guide is worse than a build that stops.',
    );
    this.name = 'Unsupported';
  }
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- links ------------------------------------------------------------------
//
// A guide's cross-references point at GitHub, because they are written to be
// read from a repository and from inside an install, where there is no website.
// On the website the sibling guides are one directory away, so those specific
// links are rewritten and everything else is left exactly as the author wrote
// it. The rewrite is deliberately narrow: a link into the repository that is
// NOT another guide must stay pointing at the repository, because the website
// does not host the repository.
const GH_BLOB = 'https://github.com/filelayer/filelayer/blob/main/';

function rewriteHref(href, file = 'docs/guides/x.md') {
  // WHICH SOURCE THIS LINK WAS WRITTEN IN decides what a relative path means.
  //
  // `docs/guides/*.md` link each other as bare siblings and those become site
  // URLs. Every other page rendered here -- `docs/QUICKSTART.md` is the first
  // -- is a document that lives in a repository and links to OTHER files in
  // that repository, which the website does not serve. Resolving those against
  // the source file's own directory and sending them to GitHub is the only
  // answer that is not a 404; the alternative was rewriting the markdown so it
  // reads worse in the repository, where most of its readers still are.
  const guide = file.startsWith('docs/guides/');

  // Absolute, or a pure fragment: the author meant it, leave it.
  if (/^(https?:|mailto:|#)/.test(href)) {
    return href.startsWith(`${GH_BLOB}docs/guides/README.md`)
      ? '/guides/'
      : href.replace(
          new RegExp(`^${GH_BLOB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}docs/guides/([a-z0-9-]+)\\.md(#.*)?$`),
          (_, slug, frag) => `/guides/${slug}${frag ?? ''}`,
        );
  }

  // A SIBLING FILE, WRITTEN BARE. `docs/guides/README.md` links the four guides
  // as `expiring-and-revocable-file-links.md`, with no `./` in front, which is
  // the ordinary way to write a sibling link in a repository. The first version
  // of this function handled `./x.md` and the full GitHub URL and not this, so
  // the built index page carried four links to `<slug>.md` paths that the
  // website does not serve: every link on the guides index would have 404ed,
  // on the one page whose entire job is to send readers to the other four.
  const strip = href.replace(/^\.\//, '');
  const [path, frag = ''] = strip.split(/(?=#)/);

  if (!guide) {
    // Resolve against the source file's directory, inside the repository, and
    // refuse anything that climbs out of it rather than emitting a GitHub URL
    // for a path that is not in this repository at all.
    const parts = file.split('/').slice(0, -1).concat(path.split('/'));
    const resolved = [];
    for (const seg of parts) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') {
        if (resolved.length === 0) return `UNRESOLVED:${href}`;
        resolved.pop();
        continue;
      }
      resolved.push(seg);
    }
    return `${GH_BLOB}${resolved.join('/')}${frag}`;
  }

  if (/^README\.md$/.test(path)) return `/guides/${frag}`;
  const md = path.match(/^([a-z0-9-]+)\.md$/);
  if (md) return `/guides/${md[1]}${frag}`;

  // The proof scripts are NOT served by the website. They are executable files
  // in a repository and that is where they have to point, or the claim that the
  // samples are verified becomes a dead link.
  if (/^[a-z0-9-]+\.proof\.mjs$/.test(path)) return `${GH_BLOB}docs/guides/${path}`;

  // Anything else relative is a file this generator does not know how to place.
  // Returning it unchanged is what produced the 404s above, so it is returned
  // marked instead, and the link audit below refuses to build.
  return `UNRESOLVED:${href}`;
}

// --- inline -----------------------------------------------------------------

function inline(text, file, line) {
  // Code spans come out first and are never looked inside again, so markdown
  // characters in a sample (`tenant/<org>/<file>`, `<script>`) stay literal.
  const spans = [];
  let work = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${esc(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  // REFUSE BEFORE DOING ANYTHING TO THE TEXT. Two bugs, both in the first
  // version of this function, both the same mistake, and both found only
  // because each refusal was tested on its own rather than inferred from a
  // clean run:
  //
  //   1. `![` was checked AFTER the link substitution. `![alt](x.png)` contains
  //      `[alt](x.png)`, the link pattern consumed it, and the page shipped a
  //      stray `!` in front of an anchor. A refusal that runs after a rewrite
  //      cannot refuse what the rewrite swallows.
  //   2. Raw HTML was checked after `esc()`, which had already turned every
  //      `<` into `&lt;`, so the pattern could not match anything ever. A dead
  //      check reads exactly like a live one in a passing build.
  //
  // Raw HTML is refused rather than escaped for a specific reason: GitHub
  // renders these same files and WOULD honour it, so escaping it here would
  // make the two surfaces disagree about what a guide says, quietly, with the
  // repository copy being the one that looks right.
  const forbidden = [
    [/!\[/, 'an image (the guides have none, and a broken one would ship silently)'],
    [/~~/, 'strikethrough'],
    [/^\s*\[\^|\]\[/, 'a footnote or a reference-style link'],
    [/<\/?[a-zA-Z][^>]*>/, 'raw HTML in prose, which GitHub would render and this escapes'],
  ];
  for (const [re, what] of forbidden) {
    if (re.test(work)) throw new Unsupported(file, line, what, text);
  }

  work = esc(work);

  // Links before bold and emphasis, so a label may contain either.
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = rewriteHref(href, file);
    const external = /^https?:/.test(h);
    return `<a href="${h}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });

  // BOLD MAY CONTAIN EMPHASIS. `**Answer *multiple* ranges in one request**`
  // is ordinary markdown and the first version of this pattern -- `[^*]+`
  // between the fences -- could not match it at all, so the leftover check
  // below reported "unbalanced bold" about a line that was perfectly balanced.
  // A refusal that names the wrong defect costs more than no refusal.
  //
  // Lazy, and the inner class admits a single `*` but never a `**`, so the
  // first closing pair still closes the span and two adjacent bold runs do not
  // merge into one.
  work = work.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  // AND DENY WHAT IS LEFT. These are constructs the rewrites above could not
  // consume, so checking for them afterwards is the only place they show up.
  const leftovers = [
    [/\[[^\]]*\]\(/, 'a link this renderer could not parse (whitespace in the URL?)'],
    [/\*\*/, 'unbalanced bold'],
    [/(^|[^*])\*(?!\*)/, 'unbalanced emphasis'],
    [/`/, 'an unbalanced code span'],
  ];
  for (const [re, what] of leftovers) {
    if (re.test(work)) throw new Unsupported(file, line, what, text);
  }

  return work.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

// --- blocks -----------------------------------------------------------------

function render(md, file) {
  const lines = md.split('\n');
  const out = [];
  const ids = [];
  let i = 0;
  let title = null;
  let lede = null;

  const flushParagraph = (buf, startLine) => {
    if (!buf.length) return;
    const text = buf.join(' ').trim();
    const html = inline(text, file, startLine);
    if (lede === null) lede = text.replace(/[*`[\]]|\(https?:[^)]*\)/g, '').trim();
    out.push(`<p>${html}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const no = i + 1;

    if (/^\s*$/.test(line)) { i++; continue; }

    // HTML COMMENTS ARE DROPPED, INCLUDING MULTI-LINE ONES.
    //
    // Not cosmetic. Until 7 October 2026 a comment was treated as ordinary
    // prose, so `esc()` turned it into `&lt;!-- ... --&gt;` and every guide
    // page published the `<!-- doccheck-setup ... -->` block as a visible
    // paragraph: internal tooling vocabulary, printed to readers, on all five
    // pages, from the day the pages went live. Nobody caught it because the
    // boundary gate reads the markdown, where it is correctly a comment, and
    // because reading your own page is the one check nothing automates.
    //
    // A comment is invisible BY DEFINITION. Rendering one at all was the bug;
    // dropping it is not a special case for `doccheck`.
    if (/^\s*<!--/.test(line)) {
      let j = i;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      if (j >= lines.length) throw new Unsupported(file, no, 'an unclosed HTML comment', line);
      i = j + 1;
      continue;
    }

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new Unsupported(file, no, 'an unclosed code fence', line);
      i++;
      const cls = lang ? ` class="lang-${lang}"` : '';
      out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (level > 3) throw new Unsupported(file, no, `an h${level} (the subset stops at h3)`, line);
      const text = inline(h[2], file, no);
      if (level === 1) {
        if (title !== null) throw new Unsupported(file, no, 'a second h1 (one page, one title)', line);
        title = h[2].replace(/[*`]/g, '');
        out.push(`<h1>${text}</h1>`);
      } else {
        // ONE SPACE BECOMES ONE DASH, and runs are NOT collapsed, because the
        // tables of contents these pages carry were written against GitHub's
        // slugger and are read on GitHub too. GitHub removes the punctuation
        // first and replaces what is left space-for-space, so `Tier 1 — a
        // public file` is `tier-1--a-public-file` there: two dashes where the
        // em dash was. Collapsing produced `tier-1-a-public-file` here, and a
        // contents list that worked in the repository and silently went
        // nowhere on the website. Fragments are validated in the link audit
        // below, so a future divergence fails the build rather than shipping.
        const id = h[2]
          .toLowerCase()
          .replace(/`[^`]*`/g, (s) => s.replace(/`/g, ''))
          .replace(/[^a-z0-9 -]/g, '')
          .trim()
          .replace(/ /g, '-');
        ids.push(id);
        out.push(`<h${level} id="${id}">${text}</h${level}>`);
      }
      i++;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // table: a header row, a separator row, then body rows
    if (/^\|/.test(line)) {
      if (!/^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
        throw new Unsupported(file, no, 'a table without a separator row under its header', line);
      }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        '<div class="table-scroll"><table>\n<thead><tr>' +
          head.map((c) => `<th>${inline(c, file, no)}</th>`).join('') +
          '</tr></thead>\n<tbody>' +
          body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, file, no)}</td>`).join('')}</tr>`)
            .join('\n') +
          '</tbody>\n</table></div>',
      );
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(body.join(' ').trim(), file, no)}</p></blockquote>`);
      continue;
    }

    // lists, one level of nesting, with items that may wrap
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      let depth = li[1].length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m && m[1].length === depth) {
          // AN ITEM IS PROSE, AND IT MAY ALSO CARRY AN INDENTED CODE BLOCK.
          //
          // `docs/QUICKSTART.md` does this twice: a numbered point whose whole
          // value is the three lines of TypeScript underneath it. The fenced
          // rule in the main loop only matches a fence in column zero, so an
          // indented one used to fall through to the paragraph rule, where
          // `inline()` met three backticks and refused -- correctly, and with
          // a message about an unbalanced code span, which is not what was
          // wrong. Supported here instead, which is what the header of this
          // file says to do when the corpus needs a construct.
          const parts = [];
          let buf = [m[3]];
          i++;
          const flush = () => {
            const text = buf.join(' ').trim();
            if (text) parts.push(parts.length === 0 ? inline(text, file, no) : `<p>${inline(text, file, no)}</p>`);
            buf = [];
          };
          for (;;) {
            // continuation lines of the same item: indented, and not a new bullet
            while (
              i < lines.length &&
              /^\s+\S/.test(lines[i]) &&
              !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
              !/^```/.test(lines[i].trim())
            ) {
              buf.push(lines[i++].trim());
            }
            // A BLANK LINE DOES NOT END THE ITEM, and this is where the
            // content gets lost if you assume it does. Markdown lets an item
            // carry several blocks separated by blank lines, as long as they
            // stay indented; QUICKSTART's listing note is prose, a blank line,
            // a code block, a blank line and more prose. Look PAST the blanks,
            // and only consume them once something indented is actually there.
            let k = i;
            while (k < lines.length && /^\s*$/.test(lines[k])) k++;
            const more =
              k < lines.length &&
              /^\s+\S/.test(lines[k]) &&
              !/^(\s*)([-*]|\d+\.)\s+/.test(lines[k]);
            if (!more) break;
            if (!/^\s+```/.test(lines[k])) {
              // Indented prose after a blank line: another paragraph of this
              // same item.
              i = k;
              flush();
              continue;
            }
            i = k;
            flush();
            const fence = lines[i];
            const indent = fence.match(/^(\s*)/)[1].length;
            const lang = fence.trim().slice(3).trim();
            i++;
            const code = [];
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++].slice(indent));
            if (i >= lines.length) {
              throw new Unsupported(file, no, 'an unclosed code fence inside a list item', fence);
            }
            i++;
            parts.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
          }
          flush();
          items.push(`<li>${parts.join('')}</li>`);
          continue;
        }
        if (m && m[1].length > depth) {
          // A nested list is rendered inside the item that precedes it.
          const nested = [];
          const sub = m[1].length;
          while (i < lines.length) {
            const n = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
            if (!n || n[1].length !== sub) break;
            nested.push(`<li>${inline(n[3], file, i + 1)}</li>`);
            i++;
          }
          const last = items.pop() ?? '<li>';
          items.push(last.replace(/<\/li>$/, `<ul>${nested.join('')}</ul></li>`));
          continue;
        }
        break;
      }
      void depth;
      out.push(`<${tag}>${items.join('\n')}</${tag}>`);
      continue;
    }

    // paragraph: consume until a blank line or a line that starts a block
    const buf = [];
    const start = no;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6}\s|```|>|\||---+\s*$)/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    flushParagraph(buf, start);
  }

  if (title === null) throw new Unsupported(file, 1, 'no h1, so the page has no title', '');
  return { html: out.join('\n'), title, lede, ids };
}

// --- the page ---------------------------------------------------------------

const clip = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};

function page({ url, source, title, lede, body }) {
  const desc = clip(lede ?? '', 185);

  // THE FOOTER CLAIM IS DERIVED FROM THE PAGE, NOT ASSERTED ABOUT IT.
  //
  // It read "the code samples in the guides are executed by CI" while the only
  // pages were guides. Generalising it to "on this page" made it more precise
  // and, for the first page with no samples, false -- and that page was
  // `/trust`, whose entire job is to be accurate about what is and is not
  // verified. A false claim about verification, on the verification page, is
  // the worst place this project could have put one.
  //
  // `lang-ts` is exactly what `check:docs` extracts and runs, so this is the
  // same question the gate asks rather than a second opinion about it.
  const samples = /<code class="lang-ts">/.test(body)
    ? ' The TypeScript on this page is executed by CI on every commit; a sample that' +
      ' stops working fails the build.'
    : '';

  // THE BRAND SUFFIX IS THE PART THAT GIVES WAY. Search results truncate a
  // title around 70 characters, and these titles are questions: the question is
  // the whole value of the page and " · Filelayer" is a nicety. Two of the four
  // guides were at 74 and 78 characters with the suffix and under 70 without,
  // so the rule is to add it only when it fits.
  //
  // Found by `check:web` on 6 October 2026, the day it was taught to read these
  // pages at all. They had been live, and in Google's indexing queue, with
  // titles that would have been cut mid-sentence.
  const withBrand = `${title} · Filelayer`;
  const pageTitle = withBrand.length <= 70 ? withBrand : title;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description: desc,
    url,
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'Filelayer', url: `${SITE}/` },
    about: {
      '@type': 'SoftwareSourceCode',
      name: 'Filelayer',
      alternateName: '@filelayer/core',
      codeRepository: 'https://github.com/filelayer/filelayer',
      softwareVersion: VERSION,
    },
    author: { '@type': 'Organization', name: 'Technology Pro Bono S.L.' },
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!--
  GENERATED FILE. DO NOT EDIT.
  Source: ${source}
  Built by tools/build-guides.mjs, and \`npm run check:guides\` fails the build
  if this file differs by one byte from what that source renders to. Edit the
  markdown.
-->

<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(desc)}">

<link rel="canonical" href="${url}">
<link rel="stylesheet" href="/styles.css">
<meta name="theme-color" content="#14161a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbfaf8" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="light dark">

<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:alt" content="Filelayer — the file layer for SaaS applications">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${SITE}/og.png">

<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2314161a'/%3E%3Cpath d='M7 10h18M7 16h18M7 22h18' stroke='%23fbfaf8' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M7 16h18' stroke='%230f766e' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E">

<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<div class="wrap">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Filelayer home">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="currentColor"/>
        <path d="M7 10h18M7 22h18" stroke="var(--paper)" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M7 16h18" stroke="#0f766e" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      Filelayer
    </a>
    <nav class="nav" aria-label="Primary">
      <a href="/quickstart">Quickstart</a>
      <a href="/guides/">Guides</a>
      <a href="https://github.com/filelayer/filelayer">GitHub</a>
    </nav>
  </header>
</div>

<main id="main" class="wrap">
<article class="guide">
${body}
</article>

<footer class="guide-foot">
  <p>
    This page is generated from
    <a href="${GH_BLOB}${source}" rel="noopener"><code>${source}</code></a>
    in a public repository.${samples}
  </p>
  <p>
    <a href="/quickstart">Quickstart</a> ·
    <a href="/guides/">All guides</a> ·
    <a href="/">Filelayer</a> ·
    <a href="/trust">Should you depend on this?</a>
  </p>
  <p class="fine">
    Filelayer ${VERSION}, alpha. Apache-2.0, with a patent grant.
    Copyright 2026 Technology Pro Bono S.L.
  </p>
</footer>
</main>

</body>
</html>
`;
}

// --- build ------------------------------------------------------------------

// THE PAGES THIS GENERATOR SERVES, discovered where discovery is possible and
// declared where it is not.
//
// The guides are a directory and are discovered from it. `docs/QUICKSTART.md`
// is one named file in a directory of files that are NOT website pages, so it
// is declared -- and it is declared here, once, rather than special-cased
// downstream.
//
// WHY THE QUICKSTART IS ON THIS DOMAIN AT ALL. Until 17 October 2026 the site's
// "Docs" link went to GitHub, so `filelayer.dev` had no install page. An agent
// answering "how do I install and authenticate this?" -- the highest-intent
// question in the whole funnel, and the one a coding agent asks with a `site:`
// operator in nine searches out of ten -- found nothing on our own domain.
//
// The markdown stays the single source: this renders it, `npm run check:guides`
// re-renders in memory and fails on a one-byte difference, and there is no
// second copy to drift.
const sources = [
  ...readdirSync(SRC)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      const isIndex = slug === 'README';
      return {
        src: `docs/guides/${f}`,
        out: isIndex ? 'guides/index.html' : `guides/${slug}.html`,
        url: isIndex ? `${SITE}/guides/` : `${SITE}/guides/${slug}`,
        slug: isIndex ? '' : slug,
        isGuide: true,
        isIndex,
      };
    }),
  {
    src: 'docs/QUICKSTART.md',
    out: 'quickstart.html',
    url: `${SITE}/quickstart`,
    slug: null,
    isGuide: false,
    isIndex: false,
  },
  // AND THE PAGE THAT ARGUES AGAINST ADOPTING IT.
  //
  // `TRUST.md` is the honest answer to "should you depend on this?", zeros
  // included, and until now it was only on GitHub -- so every page on this site
  // linked to it and none of them could be read without leaving the site. A
  // reader deciding whether to adopt is looking for exactly the disqualifying
  // information, and a vendor that supplies it is more useful than one that
  // makes them go and find it.
  {
    src: 'TRUST.md',
    out: 'trust.html',
    url: `${SITE}/trust`,
    slug: null,
    isGuide: false,
    isIndex: false,
  },
];

const built = [];
for (const s of sources) {
  const md = readFileSync(join(ROOT, s.src), 'utf8');
  const { html, title, lede, ids } = render(md, s.src);
  built.push({
    ...s,
    title,
    lede,
    ids,
    text: page({ url: s.url, source: s.src, title, lede, body: html }),
  });
}

// --- fidelity: nothing was dropped on the way through -----------------------
//
// The renderer refuses what it does not understand, which stops it from
// MISRENDERING. It does not by itself stop it from DROPPING: a block rule whose
// loop advances one line too many swallows content and throws nothing, and the
// page still looks plausible because what is missing is not visible. The
// nine-item list that silently became eight is the kind of thing a reader finds
// and a clean build does not.
//
// So every structure in the source is counted and must appear in the output.
// These are counts rather than a text comparison because inline markdown is
// rewritten by design, and a diff of the prose would be noise. A count is
// coarse and it catches the failure that matters: content that is simply gone.
{
  const problems = [];
  for (const b of built) {
    const f = b.src;
    const md = readFileSync(join(ROOT, f), 'utf8');
    const body = b.text.slice(b.text.indexOf('<article'), b.text.indexOf('</article>'));

    // Fenced blocks come in pairs, so the opening count is half the fences.
    const fences = (md.match(/^\s*```/gm) ?? []).length;
    const lines = md.split('\n');
    const inFence = lines.map(((open) => (l) => (/^\s*```/.test(l) ? ((open = !open), true) : open))(false));
    const outside = lines.filter((_, i) => !inFence[i]);

    const expect = {
      '<pre>': fences / 2,
      '<h1>': outside.filter((l) => /^# /.test(l)).length,
      '<h2 ': outside.filter((l) => /^## /.test(l)).length,
      '<h3 ': outside.filter((l) => /^### /.test(l)).length,
      '<li>': outside.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l)).length,
      '<hr>': outside.filter((l) => /^---+\s*$/.test(l)).length,
      '<blockquote>': 0, // counted below: consecutive `>` lines collapse into one
    };
    let quotes = 0;
    for (let i = 0; i < outside.length; i++) {
      if (/^>\s?/.test(outside[i]) && !/^>\s?/.test(outside[i - 1] ?? '')) quotes++;
    }
    expect['<blockquote>'] = quotes;

    for (const [tag, want] of Object.entries(expect)) {
      const got = (body.match(new RegExp(tag.replace(/[[\]().*+?^${}|\\]/g, '\\$&'), 'g')) ?? []).length;
      if (got !== want) {
        problems.push(
          `${f}: the source has ${want} ${tag.trim()} block(s); the rendered page has ${got}. ` +
            'Content was dropped or duplicated by a block rule in this file.',
        );
      }
    }

    // EVERY href, not the ones that happen to start with a slash. The first
    // version of this audit matched `href="/..."` only, so the four bare
    // relative links on the index page were not merely unrewritten, they were
    // also unexamined: a check that inspects a subset reports clean on exactly
    // the hrefs it does not read. Deny by default, and classify every one.
    for (const m of body.matchAll(/href="([^"]*)"/g)) {
      const href = m[1];
      if (href.startsWith('UNRESOLVED:')) {
        problems.push(
          `${f}: rewriteHref() does not know where to put ` +
            `\`${href.slice('UNRESOLVED:'.length)}\`. Teach it, or make the link absolute in ` +
            'the markdown so it points at the repository.',
        );
        continue;
      }
      // A FRAGMENT IS A LINK LIKE ANY OTHER, and it is the one kind that fails
      // silently: a browser handed an id that does not exist scrolls nowhere
      // and reports nothing. `docs/QUICKSTART.md` opens with an eleven-item
      // contents list, so an unvalidated slugger would have shipped eleven
      // dead links on the page this site most needs to work.
      if (href.startsWith('#')) {
        if (!b.ids.includes(href.slice(1))) {
          problems.push(
            `${f}: links to \`${href}\`, and no heading on the rendered page has that id. ` +
              'Either the heading was renamed or the slugger disagrees with the one the ' +
              'contents list was written against.',
          );
        }
        continue;
      }
      if (/^(https?:|mailto:)/.test(href)) continue;
      if (['/', '/styles.css', '/quickstart', '/trust'].includes(href)) continue;
      if (href.startsWith('/guides')) {
        const slug = href.replace(/^\/guides\/?/, '').split('#')[0];
        const ok = slug === '' ? built.some((b) => b.isIndex) : built.some((b) => b.slug === slug);
        if (!ok) {
          problems.push(
            `${f}: the link rewrite produced ${href}, which is not a page this ` +
              'generator builds. Fix rewriteHref() rather than the markdown.',
          );
        }
        continue;
      }
      problems.push(
        `${f}: emitted the link \`${href}\`, which is neither absolute, nor a ` +
          'fragment, nor a page or asset this site serves. The website is not the repository, ' +
          'so a relative path that works in a checkout 404s here.',
      );
    }
  }

  // Every class the template and the renderer emit must exist in the stylesheet,
  // because an unstyled table on a published page looks like a broken page.
  const css = readFileSync(join(ROOT, 'web', 'styles.css'), 'utf8');
  for (const cls of ['guide', 'table-scroll', 'guide-foot', 'fine', 'wrap', 'masthead', 'brand', 'nav', 'skip']) {
    if (!new RegExp(`\\.${cls}\\b`).test(css)) {
      problems.push(`web/styles.css has no rule for .${cls}, which these pages use.`);
    }
  }

  if (problems.length) {
    console.error(`\nbuild-guides: FAILED\n\n${problems.map((p) => `  - ${p}`).join('\n\n')}\n`);
    process.exit(1);
  }
}

// THE SITEMAP IS A LIST OF THE SITE'S PAGES, SO IT IS DERIVED FROM THEM.
//
// It used to be derived from `built` -- the guides THIS tool renders -- plus a
// hard-coded root URL. That is a different set, and it agreed with the site
// only for as long as the site was the landing page plus the guides. A page
// added anywhere else under web/ would have been silently absent from the
// sitemap, and worse: this tool rewrites sitemap.xml on every build, so it
// would have been REMOVED again by the next `npm run build:guides` if anyone
// had added it by hand.
//
// Discovered over what git tracks, for the usual reason -- an untracked page
// does not deploy, and listing it would point crawlers at a 404.
const pageUrl = (rel) => {
  const path = rel.replace(/^web\//, '').replace(/\.html$/, '');
  if (path === 'index') return { url: `${SITE}/`, priority: '1.0', changefreq: 'weekly' };
  if (path.endsWith('/index')) {
    return { url: `${SITE}/${path.slice(0, -'/index'.length)}/`, priority: '0.8', changefreq: 'monthly' };
  }
  return { url: `${SITE}/${path}`, priority: '0.9', changefreq: 'monthly' };
};

const sitemapEntries = execFileSync('git', ['ls-files', '-z', '--', 'web'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter((f) => f.endsWith('.html'))
  .map(pageUrl)
  // Root first, then alphabetically, which is what the previous ordering
  // produced and what keeps the diff on this file readable.
  .sort((a, b) => (a.priority === '1.0' ? -1 : b.priority === '1.0' ? 1 : a.url.localeCompare(b.url)));

if (!sitemapEntries.some((e) => e.url === `${SITE}/`)) {
  console.error(
    'build-guides: web/index.html is not tracked, so the sitemap would have no root URL.',
  );
  process.exit(2);
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries
  .map(
    (e) => `  <url>
    <loc>${e.url}</loc>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

const artifacts = [
  ...built.map((b) => ({ path: join('web', b.out), text: b.text })),
  { path: join('web', 'sitemap.xml'), text: sitemap },
];

if (CHECK) {
  const stale = [];
  for (const a of artifacts) {
    const full = join(ROOT, a.path);
    if (!existsSync(full)) {
      stale.push(`${a.path}: not committed. Run \`npm run build:guides\`.`);
      continue;
    }
    if (readFileSync(full, 'utf8') !== a.text) {
      stale.push(
        `${a.path}: does not match what its markdown source renders to. ` +
          'Either the HTML was edited by hand, which it must never be, or the markdown ' +
          'changed without rebuilding.\n      Run `npm run build:guides` and commit the result.',
      );
    }
  }
  if (stale.length) {
    console.error(`\nbuild-guides: FAILED\n\n${stale.map((s) => `  - ${s}`).join('\n\n')}\n`);
    process.exit(1);
  }
  console.log(
    `build-guides: clean. ${built.length} page(s) under web/ are byte-identical to ` +
      `what their markdown sources render to, and web/sitemap.xml lists the ` +
      `${sitemapEntries.length} tracked page(s) under web/.`,
  );
} else {
  mkdirSync(OUT, { recursive: true });
  for (const a of artifacts) writeFileSync(join(ROOT, a.path), a.text);
  console.log(
    // `built.length + 1` until the sitemap stopped being "the guides plus the
    // root". It now lists every tracked page under web/, so the only honest
    // source for this number is the thing that was written.
    `build-guides: wrote ${built.length} page(s) under web/ and ${sitemapEntries.length} ` +
      'URL(s) to web/sitemap.xml.',
  );
  for (const b of built) console.log(`  ${b.url.replace(SITE, '')}  ${b.title}`);
}
