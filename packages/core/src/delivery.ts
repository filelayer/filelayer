/**
 * BYTE DELIVERY -- the library owns the response, not the developer.
 *
 * A security review found three live defects here and correctly identified their
 * common root cause: `read()` and `redeem()` handed back a `Uint8Array` and
 * left everything that happens to those bytes on the way to a browser as the
 * application's problem. Three of the four security-sensitive decisions the
 * library was still leaving to the developer lived in that gap:
 *
 *   - no `X-Content-Type-Options: nosniff` / `Content-Disposition` on the
 *     authenticated read  -> a user-uploaded .html or .svg executes in OUR OWN
 *     origin. Stored XSS with full session access, cross-tenant reach.
 *   - no `Cache-Control: no-store` on the share download -> a revoked link is
 *     replayable from disk cache or an intermediary. This one is worse than it
 *     sounds: immediate revocation is the product's headline property, and a
 *     cache replay partially defeats it.
 *   - the share password in the query string -> the secret AND the password
 *     land in access logs, proxy logs, browser history, and the `Referer`
 *     header of any outbound link inside the delivered document.
 *
 * The fix is not "document the headers". A decision the developer can forget is
 * a decision they will eventually forget, which is the entire premise of this
 * design. So:
 *
 *   1. `read()` and `redeem()` now return a DELIVERY DESCRIPTOR -- bytes plus
 *      the exact headers required to serve them safely. The headers are
 *      computed by the library from the file record; there is no argument that
 *      turns them off.
 *   2. Framework-agnostic writers are provided (`toResponse` for anything with
 *      a WHATWG `Response`, `sendNodeResponse` for `node:http`), so the
 *      developer writes one line and cannot write the wrong headers.
 *   3. For the share path the library owns the ROUTE, not just the response,
 *      because the password-in-the-URL defect is a routing decision rather than
 *      a response decision. `shareDownloadRoute()` reads the password from the
 *      request body and REFUSES, loudly, with 400, if a credential appears in
 *      the query string. A silent decision has been converted into a noisy one,
 *      which by our own definition means it stops being a security-sensitive
 *      decision at all.
 *
 * Residual, stated plainly: `delivery.body` is still a public field, so a
 * developer who ignores the helpers and hand-writes `res.end(d.body)` gets the
 * old behaviour. This is "hard to get wrong", not "impossible to get wrong".
 * Making it impossible would mean never exposing the bytes, which would break
 * every non-HTTP consumer (a queue worker, a virus scanner, a thumbnailer).
 * We chose the weaker guarantee deliberately and state it rather than hide it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Filelayer } from './filelayer.ts';
import type { Principal } from './authz.ts';
import { FilelayerError } from './errors.ts';

export type Disposition = 'attachment' | 'inline';

export interface DeliverableFile {
  name: string;
  contentType: string;
  sizeBytes?: number | null;
}

export interface FileDelivery {
  file: DeliverableFile;
  body: Uint8Array;
  /**
   * Everything that must be on the response. Lowercased, ready to spread into
   * `res.writeHead()` or a `Headers` init.
   */
  headers: Record<string, string>;
}

// =============================================================================
// DELIVERY MODES
// =============================================================================
//
// There are exactly two, they have different security properties, and the
// difference is deliberately impossible to stumble into.
//
//   'proxy'    (DEFAULT, and the only mode available unless you configure the
//              other one) -- the bytes flow through this process. Every request
//              is authorized. Revocation is immediate, full stop: the next
//              request after a revoke gets 404, including one already in flight
//              only in the sense that it has not yet reached us.
//
//   'redirect' (OPT-IN, and the opt-in is verbose on purpose) -- we authorize,
//              we audit, and we answer 302 to a short-lived presigned URL. The
//              bytes never touch this process, so it is CDN-cacheable for a
//              public asset and costs no egress and no heap.
//
// THE TRADE, STATED THE WAY AN AUDITOR NEEDS IT STATED:
//
//   Revocation is immediate at DECISION time, plus up to `ttlSeconds` of
//   in-flight window.
//
// Concretely: if a grant is revoked at T, no NEW redirect is issued from T
// onward -- that part is as immediate as the proxied path. But a redirect
// issued at T-1 hands out a URL the object store will honour until
// T-1+ttlSeconds, and the object store has never heard of a grant. There is no
// way to recall it; AWS's own documented answer is "rotate the signing
// credential", which revokes every URL for every tenant at once and is not a
// per-grant control. So the window is real and bounded, and the bound is the
// TTL, and the TTL is bounded by us.
//
// Consequences that are enforced rather than documented:
//   - the config will not typecheck without the acknowledgement string;
//   - `ttlSeconds` is clamped to MAX_REDIRECT_TTL_SECONDS whatever you pass;
//   - by default ONLY anonymous (published/public) grants may be redirected,
//     because a public asset's residual window is a window onto something
//     already public. Private grants stay proxied unless you widen the scope
//     explicitly;
//   - every redirected delivery writes a `file.deliver` audit event carrying
//     `mode: 'redirect'`, the TTL and the resulting window, so a compliance auditor can
//     answer "which deliveries were proxied and which were redirected" from the
//     log rather than from a config file they have to trust;
//   - the presigned URL pins `response-content-type` and
//     `response-content-disposition`, so the object store serves the same
//     neutralised type and `attachment` disposition the proxied path would
//     have. A redirect does not lose the response-header protections.

export type DeliveryMode = 'proxy' | 'redirect';

/**
 * The literal a developer must type to enable redirect delivery.
 *
 * A boolean would be typed once and forgotten. A sentence has to be read to be
 * copied, it appears verbatim in the diff, and it shows up in a grep of the
 * codebase when someone asks "do we ever hand out URLs that outlive a
 * revocation?" -- which is the question this whole mode exists to make
 * answerable.
 */
export const REDIRECT_ACKNOWLEDGEMENT =
  'I accept a revocation window of up to ttlSeconds on redirected deliveries';

/**
 * Our ceiling, not the object store's. Five minutes is long enough for a client
 * to follow a redirect on a bad mobile connection and short enough that the
 * residual window is something you can put in a compliance document without
 * flinching.
 */
export const MAX_REDIRECT_TTL_SECONDS = 300;
export const DEFAULT_REDIRECT_TTL_SECONDS = 60;

export interface RedirectDeliveryConfig {
  /** Must be exactly `REDIRECT_ACKNOWLEDGEMENT`. Checked at runtime too. */
  acknowledgeRevocationWindow: typeof REDIRECT_ACKNOWLEDGEMENT;
  /** Clamped to [1, MAX_REDIRECT_TTL_SECONDS]. */
  ttlSeconds?: number;
  /**
   * 'anonymous-grants-only' (DEFAULT) -- only a delivery authorized by an
   * anonymous grant, i.e. something the customer has deliberately published,
   * may be redirected. This is the setting where the residual window is a
   * window onto an already-public object.
   *
   * 'all-grants' -- link and actor grants too. This is the setting that trades
   * a real revocation window on genuinely private data for zero-proxy
   * delivery. It is not the default and it never will be.
   */
  scope?: 'anonymous-grants-only' | 'all-grants';
}

export interface ResolvedRedirectConfig {
  ttlSeconds: number;
  scope: 'anonymous-grants-only' | 'all-grants';
}

export function resolveRedirectConfig(cfg: RedirectDeliveryConfig): ResolvedRedirectConfig {
  if (cfg.acknowledgeRevocationWindow !== REDIRECT_ACKNOWLEDGEMENT) {
    throw new FilelayerError(
      500,
      'redirect_not_acknowledged',
      'redirect delivery requires the verbatim REDIRECT_ACKNOWLEDGEMENT string',
    );
  }
  const requested = cfg.ttlSeconds ?? DEFAULT_REDIRECT_TTL_SECONDS;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new FilelayerError(500, 'redirect_bad_ttl', 'ttlSeconds must be >= 1');
  }
  return {
    // Clamped, not rejected: a config that asks for a day gets five minutes and
    // keeps working. Rejecting would tempt someone to "fix" it by removing the
    // bound.
    ttlSeconds: Math.min(Math.floor(requested), MAX_REDIRECT_TTL_SECONDS),
    scope: cfg.scope ?? 'anonymous-grants-only',
  };
}

/** A delivery whose bytes flow through this process. */
export interface ProxyDelivery {
  mode: 'proxy';
  file: DeliverableFile;
  headers: Record<string, string>;
  /** The bytes, as a stream. Nothing here is ever fully resident. */
  body: ReadableStream<Uint8Array>;
  /** Known length, when the store reported one. */
  bytes: number | null;
}

/** A delivery answered with a 302 to a short-lived presigned URL. */
export interface RedirectDelivery {
  mode: 'redirect';
  file: DeliverableFile;
  headers: Record<string, string>;
  status: 302;
  url: string;
  /** When the presigned URL stops working. */
  expiresAt: Date;
  /**
   * The number the compliance document needs: revocation is immediate at
   * decision time, PLUS up to this many seconds of in-flight window.
   */
  revocationWindowSeconds: number;
}

export type StreamedDelivery = ProxyDelivery | RedirectDelivery;

/**
 * Content types that execute, or can be made to execute, in the origin that
 * serves them. Served inline, any of these is stored XSS against your own
 * application. `Content-Disposition: attachment` already defeats this in every
 * current browser, so this list is the second layer: when a caller explicitly
 * asks for `inline` (PDF preview, image thumbnails -- both legitimate), an
 * active type is downgraded to `application/octet-stream` and the disposition
 * is forced back to `attachment`.
 *
 * The predicate is deliberately broader than the list: anything whose type or
 * subtype mentions html, xml, svg or script is treated as active, because the
 * failure mode of being too strict is "the PDF downloads instead of previewing"
 * and the failure mode of being too lax is session theft.
 */
const ACTIVE_TYPE_RE = /(html|xml|svg|script|xsl|ecmascript)/i;

export function isActiveContentType(contentType: string): boolean {
  return ACTIVE_TYPE_RE.test(contentType.split(';')[0] ?? '');
}

/**
 * A content type we are willing to put on a response.
 *
 * A `content-type` is attacker-controlled: it is whatever the uploader sent.
 * Anything with a CR, an LF or a NUL is a header-injection attempt and is not
 * negotiable; anything that is not a plausible media type is served as bytes.
 */
export function safeContentType(contentType: string, disposition: Disposition): string {
  const raw = contentType.trim();
  if (!/^[a-zA-Z0-9!#$&^_.+-]{1,127}\/[a-zA-Z0-9!#$&^_.+-]{1,127}$/.test(raw)) {
    return 'application/octet-stream';
  }
  if (disposition === 'inline' && isActiveContentType(raw)) return 'application/octet-stream';
  return raw;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * RFC 6266 `Content-Disposition`, with the filename encoded rather than
 * interpolated.
 *
 * NEW FINDING, found while doing this work: the example app wrote
 * `filename="${file.name}"` directly. `file.name` is whatever the uploader
 * sent. A name containing a double quote truncates the header; a name
 * containing CR/LF injects an arbitrary header, including a second
 * `Content-Type` or a `Set-Cookie`. That is a response-splitting bug in the
 * shipped example, and it is not one the comparable integrations have, because
 * none of them interpolate the name unescaped. It is fixed here, once, for
 * every caller.
 */
export function contentDisposition(name: string, disposition: Disposition): string {
  // ASCII fallback: printable ASCII only, no quote, no backslash, no path
  // separators, no control characters. Never empty.
  // Control characters (CR/LF are the header-injection vector) are dropped
  // outright; quote, backslash and path separators become underscores; anything
  // outside printable ASCII is replaced, because the extended form below is
  // what actually carries a non-ASCII name.
  const stripped = name.replace(CONTROL_CHARS, '');
  const ascii =
    stripped
      .replace(/[\\"/]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_')
      .trim()
      .slice(0, 120) || 'download';
  // RFC 5987 extended form, which carries the real (possibly non-ASCII) name.
  const utf8 = encodeURIComponent(stripped.slice(0, 200)).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The headers every Filelayer byte response carries. There is no option to
 * omit any of them.
 *
 *  nosniff            - stops content-type sniffing turning a .txt into HTML.
 *  Content-Disposition- attachment by default; the browser never renders it.
 *  Cache-Control      - `private, no-store` + `no-cache` + `must-revalidate`.
 *                       This is the one that matters most: it is what makes
 *                       "revocation is immediate" true at the browser and at
 *                       every intermediary, not just at our origin.
 *  Pragma / Expires   - the HTTP/1.0 spelling of the same thing, because
 *                       corporate proxies are real.
 *  Referrer-Policy    - `no-referrer`. A share link's secret is in the URL. Any
 *                       outbound link inside a delivered document would leak it
 *                       in the Referer header. This closes the third vector of
 *                       the credential-in-the-URL defect, the one that survives
 *                       moving the password out of the query string.
 *  CSP sandbox        - defence in depth for the inline case and for any future
 *                       caller that overrides disposition.
 *  X-Frame-Options    - the delivered bytes cannot be framed by a third party.
 */
export function deliveryHeaders(
  file: DeliverableFile,
  opts: { disposition?: Disposition } = {},
): Record<string, string> {
  const requested = opts.disposition ?? 'attachment';
  // An active type is never served inline, whatever was asked for.
  const disposition =
    requested === 'inline' && isActiveContentType(file.contentType) ? 'attachment' : requested;

  const headers: Record<string, string> = {
    // Found by test/tiers.test.ts: `disposition` here has ALREADY been
    // flipped to 'attachment' for an active type, so passing it to
    // `safeContentType` meant the `disposition === 'inline' && isActive`
    // branch could never fire and the type neutralisation was dead code. It
    // must be evaluated against what the CALLER ASKED FOR, not against the
    // value we corrected it to. Belt and braces are both wanted here: the
    // disposition defeats current browsers, the neutralised type defeats a
    // future one (and any non-browser client that ignores disposition).
    'content-type': safeContentType(file.contentType, requested),
    'content-disposition': contentDisposition(file.name, disposition),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-frame-options': 'DENY',
  };
  if (file.sizeBytes != null) headers['content-length'] = String(file.sizeBytes);
  return headers;
}

/** The same headers, minus the body ones, for a JSON error on a delivery path. */
export function errorHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'cache-control': 'private, no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

/**
 * The headers on a 302 to a presigned URL.
 *
 * `cacheable` is true for an ANONYMOUS grant and only for an anonymous grant.
 * That is the "public/anonymous grants should be able to use a cacheable path"
 * requirement, and the negative half of it is the important half: nothing that
 * was not already public becomes cacheable by a shared cache, ever.
 *
 * The cache lifetime is HALF the presigned URL's TTL. A cached 302 hands a
 * client a URL that is already partly used up, so caching for the full TTL
 * would let a client receive a redirect with milliseconds of life left and see
 * a spurious 403. Half guarantees at least half the TTL remains.
 *
 * The 302 itself carries no bytes, so it carries no content-type protections;
 * those are pinned INTO the presigned URL by the caller (see
 * `Filelayer.readStream`), which is what stops a redirect from being a way to
 * lose them.
 */
export function redirectHeaders(
  url: string,
  opts: { ttlSeconds: number; cacheable: boolean },
): Record<string, string> {
  return {
    location: url,
    'cache-control': opts.cacheable
      ? `public, max-age=${Math.max(1, Math.floor(opts.ttlSeconds / 2))}`
      : 'private, no-store, no-cache, must-revalidate, max-age=0',
    // The presigned URL is a credential. It is in `Location`, so it will be in
    // the browser's address bar and therefore in `Referer` on any onward
    // navigation unless we say otherwise.
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...(opts.cacheable ? {} : { pragma: 'no-cache', expires: '0' }),
  };
}

// -----------------------------------------------------------------------------
// Writers
// -----------------------------------------------------------------------------

/** WHATWG `Response` -- Workers, Deno, Bun, Next.js route handlers, Hono. */
export function toResponse(delivery: FileDelivery, status = 200): Response {
  return new Response(delivery.body as unknown as BodyInit, {
    status,
    headers: delivery.headers,
  });
}

/**
 * 206 when the body is a byte range, 200 when it is the whole object.
 *
 * `readStream()` and `redeemStream()` accept a byte range, and when the store
 * serves one they attach `Content-Range`. A partial body sent under a 200 is
 * silent data corruption: every HTTP client on earth treats 200 as "this is the
 * complete representation", so it stores, caches, hashes and hands on a
 * truncated file without a single error anywhere. The one thing that makes it
 * a range is the status code.
 *
 * So the status is DERIVED from the headers rather than left to the caller.
 * There is no value a caller could pass that this does not already know, and
 * every value they could pass by mistake is wrong.
 */
function proxyStatus(delivery: ProxyDelivery): 200 | 206 {
  return delivery.headers['content-range'] ? 206 : 200;
}

/**
 * The streaming/redirect equivalent. One function for both modes, because the
 * developer must not have to branch on the mode -- branching is where the
 * `Cache-Control` gets copied from the wrong arm.
 */
export function toStreamResponse(delivery: StreamedDelivery): Response {
  if (delivery.mode === 'redirect') {
    return new Response(null, { status: delivery.status, headers: delivery.headers });
  }
  return new Response(delivery.body as unknown as BodyInit, {
    status: proxyStatus(delivery),
    headers: delivery.headers,
  });
}

/** `node:http` / Express. */
export function sendNodeResponse(
  res: ServerResponse,
  delivery: FileDelivery,
  status = 200,
): void {
  // content-length is recomputed from the actual buffer rather than trusted
  // from the record: a size column that disagrees with the object would
  // otherwise truncate or hang the response.
  const headers = { ...delivery.headers, 'content-length': String(delivery.body.byteLength) };
  res.writeHead(status, headers);
  res.end(delivery.body);
}

/**
 * `node:http`, streaming. Nothing is buffered: the object's bytes go from the
 * store's socket to the client's socket a chunk at a time.
 *
 * The `content-length` from the record is dropped unless the STORE reported one
 * for this response, for the same reason `sendNodeResponse` recomputes it: a
 * `size_bytes` that disagrees with the object truncates or hangs the response,
 * and on a streamed response the hang is the one you notice in production
 * rather than in a test.
 */
export async function sendNodeStream(
  res: ServerResponse,
  delivery: StreamedDelivery,
): Promise<void> {
  if (delivery.mode === 'redirect') {
    res.writeHead(delivery.status, delivery.headers);
    res.end();
    return;
  }
  const headers = { ...delivery.headers };
  if (delivery.bytes === null) delete headers['content-length'];
  else headers['content-length'] = String(delivery.bytes);
  // 206 if this is a byte range. See `proxyStatus` -- a partial body under a
  // 200 is a truncated file that no client can detect.
  res.writeHead(proxyStatus(delivery), headers);

  const reader = delivery.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    // Headers are already sent, so there is no way to turn this into a status
    // code. Destroying the socket is the only honest signal that the body is
    // incomplete; ending it normally would deliver a truncated file that looks
    // like a successful download.
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    reader.releaseLock();
  }
}

function sendNodeError(res: ServerResponse, err: unknown): void {
  const e =
    err instanceof FilelayerError ? err : new FilelayerError(500, 'internal');
  res.writeHead(e.status, errorHeaders());
  res.end(JSON.stringify({ error: e.code }));
}

// -----------------------------------------------------------------------------
// Routes the library owns
// -----------------------------------------------------------------------------

/**
 * Credential names that must never appear in a URL. `secret` is not listed:
 * the share secret IS the path segment, which is the standard design and is
 * what `Referrer-Policy: no-referrer` above is for.
 */
const FORBIDDEN_QUERY_KEYS = ['password', 'pw', 'pass', 'passwd', 'token', 'secret', 'key'];

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (size > limit) throw new FilelayerError(413, 'payload_too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON or form-urlencoded, whichever the client sent. Never the query string. */
function extractPassword(raw: string, contentType: string): string | undefined {
  if (raw.length === 0) return undefined;
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const v = new URLSearchParams(raw).get('password');
    return v === null ? undefined : v;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed['password'];
    return typeof v === 'string' ? v : undefined;
  } catch {
    throw new FilelayerError(400, 'bad_request');
  }
}

export interface ShareRouteOptions {
  /** Path prefix the share links are served under. Must match `baseUrl`. */
  prefix?: string;
  disposition?: Disposition;
  /**
   * 'auto' (default) applies the INSTANCE's redirect policy -- which is "never"
   * unless `redirectDelivery` was configured and acknowledged, so the default
   * is proxying for everybody who has not opted in. 'proxy' forces proxying for
   * this route even on an instance that has opted in.
   *
   * There is no 'redirect' value. A route cannot demand a mode the instance was
   * not configured (and acknowledged) for; the opt-in lives in exactly one
   * place and it is the place with the acknowledgement string next to it.
   */
  mode?: 'proxy' | 'auto';
}

/**
 * `GET|POST <prefix>/:secret` -- the entire public share-link download path.
 *
 * The application supplies nothing. Identity is the secret itself, the password
 * is read from the body, the counter is consumed by `redeem()`, and the
 * response headers come from `deliveryHeaders()`. There is no parameter here
 * whose wrong value leaks data.
 *
 * Returns true if it handled the request, so it can be dropped into any router.
 */
export function shareDownloadRoute(
  fl: Filelayer,
  opts: ShareRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const prefix = (opts.prefix ?? '/d').replace(/\/+$/, '');

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://filelayer.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    const prefixSegments = prefix.split('/').filter(Boolean);
    if (segments.length !== prefixSegments.length + 1) return false;
    if (prefixSegments.some((s, i) => segments[i] !== s)) return false;
    if (req.method !== 'GET' && req.method !== 'POST') return false;

    const secret = decodeURIComponent(segments[prefixSegments.length]!);

    try {
      // THE FIX FOR THE CREDENTIAL-IN-THE-URL DEFECT, and the reason this
      // route exists.
      // A password (or any other credential) in the query string ends up in
      // access logs, proxy logs and browser history. The old example accepted
      // one. We refuse -- loudly, before doing any work, and without consuming
      // a download -- so the mistake cannot be made silently.
      for (const k of FORBIDDEN_QUERY_KEYS) {
        if (url.searchParams.has(k)) {
          throw new FilelayerError(400, 'credential_in_query', `query_param:${k}`);
        }
      }

      let password: string | undefined;
      if (req.method === 'POST') {
        password = extractPassword(await readBody(req), String(req.headers['content-type'] ?? ''));
      }

      // STREAMED, not buffered. This route is the one every share link goes
      // through, so buffering here was the whole-file-in-memory tax on the
      // busiest path in the product.
      const delivery = await fl.redeemStream(secret, {
        ...(password !== undefined ? { password } : {}),
        ...(req.socket.remoteAddress ? { ip: req.socket.remoteAddress } : {}),
        ...(req.headers['user-agent'] ? { userAgent: String(req.headers['user-agent']) } : {}),
        ...(opts.disposition ? { disposition: opts.disposition } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
      });

      await sendNodeStream(res, {
        ...delivery,
        headers: {
          ...delivery.headers,
          // Useful to the recipient and safe to expose: they already hold the
          // credential this counts against.
          'x-downloads-remaining': String(delivery.remainingDownloads ?? ''),
          'x-filelayer-delivery': delivery.mode,
        },
      } as StreamedDelivery);
      return true;
    } catch (err) {
      // 401 means "this link has a password". The client must re-issue as a
      // POST with the password in the body; there is no supported way to put it
      // in the URL.
      if (err instanceof FilelayerError && err.status === 401) {
        res.writeHead(401, { ...errorHeaders(), 'www-authenticate': 'FilelayerShare' });
        res.end(JSON.stringify({ error: err.code, retry: { method: 'POST', field: 'password' } }));
        return true;
      }
      sendNodeError(res, err);
      return true;
    }
  };
}

export interface FileRouteOptions {
  prefix?: string;
  disposition?: Disposition;
  /** See `ShareRouteOptions.mode`. */
  mode?: 'proxy' | 'auto';
  /** The application's own authentication. Filelayer never guesses identity. */
  principal: (req: IncomingMessage) => Principal | Promise<Principal>;
}

/**
 * `GET <prefix>/:fileId` -- the authenticated read path, headers included.
 *
 * The one thing the application must supply is who the caller is, because that
 * is the one thing Filelayer cannot know. Everything downstream of that -- the
 * decision, the audit event, the status code, and every response header -- is
 * the library's.
 */
export function fileDownloadRoute(
  fl: Filelayer,
  opts: FileRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const prefix = (opts.prefix ?? '/files').replace(/\/+$/, '');

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://filelayer.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    const prefixSegments = prefix.split('/').filter(Boolean);
    if (req.method !== 'GET') return false;
    if (segments.length !== prefixSegments.length + 1) return false;
    if (prefixSegments.some((s, i) => segments[i] !== s)) return false;

    try {
      const delivery = await fl.readStream(
        await opts.principal(req),
        segments[prefixSegments.length]!,
        {
          ...(opts.disposition ? { disposition: opts.disposition } : {}),
          ...(opts.mode ? { mode: opts.mode } : {}),
        },
      );
      await sendNodeStream(res, {
        ...delivery,
        headers: { ...delivery.headers, 'x-filelayer-delivery': delivery.mode },
      } as StreamedDelivery);
    } catch (err) {
      sendNodeError(res, err);
    }
    return true;
  };
}

export interface DeliveryHandlerOptions {
  /** Where authorized file reads are served. Must match `publicUrl()`. */
  filePrefix?: string;
  /** Where share links are served. Must match `baseUrl` + `/d`. */
  sharePrefix?: string;
  disposition?: Disposition;
  /** See `ShareRouteOptions.mode`. Applies to both routes. */
  mode?: 'proxy' | 'auto';
  /**
   * The application's authentication. Omitted means every request to the file
   * path is ANONYMOUS -- which is safe, because an anonymous principal can only
   * reach a file carrying an explicit `anonymous` grant (P1). It is not a
   * "public mode"; there is no public mode.
   */
  principal?: (req: IncomingMessage) => Principal | Promise<Principal>;
}

/**
 * The whole byte-delivery surface as one `node:http` request listener.
 *
 * `createServer(deliveryHandler(fl))` is a complete, correct file server: both
 * delivery paths, every security header, the query-string credential refusal,
 * and a 404 for everything else. The developer writes no header and no status
 * code, which means there is no header or status code for them to get wrong.
 */
export function deliveryHandler(
  fl: Filelayer,
  opts: DeliveryHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const files = fileDownloadRoute(fl, {
    prefix: opts.filePrefix ?? '/f',
    principal: opts.principal ?? (() => ({ actorId: null })),
    ...(opts.disposition ? { disposition: opts.disposition } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  const shares = shareDownloadRoute(fl, {
    prefix: opts.sharePrefix ?? '/d',
    ...(opts.disposition ? { disposition: opts.disposition } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });

  return async (req, res) => {
    if (await files(req, res)) return;
    if (await shares(req, res)) return;
    res.writeHead(404, errorHeaders());
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}
