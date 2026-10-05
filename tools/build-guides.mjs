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

function rewriteHref(href) {
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
    const h = rewriteHref(href);
    const external = /^https?:/.test(h);
    return `<a href="${h}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });

  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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
        const id = h[2]
          .toLowerCase()
          .replace(/`[^`]*`/g, (s) => s.replace(/`/g, ''))
          .replace(/[^a-z0-9 -]/g, '')
          .trim()
          .replace(/\s+/g, '-');
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
          const buf = [m[3]];
          i++;
          // continuation lines of the same item: indented, and not a new bullet
          while (
            i < lines.length &&
            /^\s+\S/.test(lines[i]) &&
            !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
            !/^```/.test(lines[i].trim())
          ) {
            buf.push(lines[i++].trim());
          }
          items.push(`<li>${inline(buf.join(' ').trim(), file, no)}</li>`);
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
  return { html: out.join('\n'), title, lede };
}

// --- the page ---------------------------------------------------------------

const clip = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};

function page({ slug, title, lede, body, isIndex }) {
  const url = isIndex ? `${SITE}/guides/` : `${SITE}/guides/${slug}`;
  const desc = clip(lede ?? '', 185);
  const pageTitle = `${title} · Filelayer`;
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

  // THE SOURCE LINK IS NOT A COURTESY. Every one of these pages is derived from
  // a file in a public repository, and the claim this project makes is that its
  // documentation is checkable. A reader who wants to see the executable proof
  // beside the prose needs the path to it, so each page carries it.
  const source = isIndex ? 'docs/guides/README.md' : `docs/guides/${slug}.md`;

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
      <a href="/guides/">Guides</a>
      <a href="https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md">Docs</a>
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
    in a public repository. The code samples in the guides are executed by CI on
    every commit; a sample that stops working fails the build.
  </p>
  <p>
    <a href="/guides/">All guides</a> ·
    <a href="/">Filelayer</a> ·
    <a href="${GH_BLOB}TRUST.md" rel="noopener">Should you depend on this?</a>
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

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.md'))
  .sort();

const built = [];
for (const f of sources) {
  const slug = f.replace(/\.md$/, '');
  const isIndex = slug === 'README';
  const md = readFileSync(join(SRC, f), 'utf8');
  const { html, title, lede } = render(md, `docs/guides/${f}`);
  built.push({
    out: isIndex ? 'index.html' : `${slug}.html`,
    slug: isIndex ? '' : slug,
    isIndex,
    title,
    lede,
    text: page({ slug, title, lede, body: html, isIndex }),
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
  for (const f of sources) {
    const md = readFileSync(join(SRC, f), 'utf8');
    const html = built.find((b) => b.out === (f === 'README.md' ? 'index.html' : f.replace(/\.md$/, '.html'))).text;
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));

    // Fenced blocks come in pairs, so the opening count is half the fences.
    const fences = (md.match(/^```/gm) ?? []).length;
    const lines = md.split('\n');
    const inFence = lines.map(((open) => (l) => (/^```/.test(l) ? ((open = !open), true) : open))(false));
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
          `docs/guides/${f}: the source has ${want} ${tag.trim()} block(s); the rendered page has ${got}. ` +
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
          `docs/guides/${f}: rewriteHref() does not know where to put ` +
            `\`${href.slice('UNRESOLVED:'.length)}\`. Teach it, or make the link absolute in ` +
            'the markdown so it points at the repository.',
        );
        continue;
      }
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      if (href === '/' || href === '/styles.css') continue;
      if (href.startsWith('/guides')) {
        const slug = href.replace(/^\/guides\/?/, '').split('#')[0];
        const ok = slug === '' ? built.some((b) => b.isIndex) : built.some((b) => b.slug === slug);
        if (!ok) {
          problems.push(
            `docs/guides/${f}: the link rewrite produced ${href}, which is not a page this ` +
              'generator builds. Fix rewriteHref() rather than the markdown.',
          );
        }
        continue;
      }
      problems.push(
        `docs/guides/${f}: emitted the link \`${href}\`, which is neither absolute, nor a ` +
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

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
${built
  .map(
    (b) => `  <url>
    <loc>${SITE}/guides/${b.slug}</loc>
    <changefreq>monthly</changefreq>
    <priority>${b.isIndex ? '0.8' : '0.9'}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

const artifacts = [
  ...built.map((b) => ({ path: join('web', 'guides', b.out), text: b.text })),
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
    `build-guides: clean. ${built.length} page(s) in web/guides/ and the sitemap are ` +
      'byte-identical to what docs/guides/*.md renders to.',
  );
} else {
  mkdirSync(OUT, { recursive: true });
  for (const a of artifacts) writeFileSync(join(ROOT, a.path), a.text);
  console.log(
    `build-guides: wrote ${built.length} page(s) to web/guides/ and ${built.length + 1} ` +
      'URL(s) to web/sitemap.xml.',
  );
  for (const b of built) console.log(`  /guides/${b.slug}  ${b.title}`);
}
