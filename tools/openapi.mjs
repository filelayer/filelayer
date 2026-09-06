#!/usr/bin/env node
/**
 * The OpenAPI description of the HTTP surface, and the generator for both
 * serialisations of it.
 *
 *   node tools/openapi.mjs           # rewrite openapi.json and openapi.yaml
 *   node tools/openapi.mjs --check   # fail if either file is stale
 *
 * WHY THIS IS A GENERATOR AND NOT TWO CHECKED-IN DOCUMENTS
 * -------------------------------------------------------
 * `openapi.json` and `openapi.yaml` describe the same thing. Two hand-written
 * copies of one fact drift, and a drifted API description is worse than none
 * because it is trusted. There is one source -- the object below -- and CI runs
 * `--check`, so a change to one serialisation without the other cannot merge.
 *
 * WHAT IS IN SCOPE, AND WHY IT IS SO SMALL
 * ----------------------------------------
 * Filelayer is a LIBRARY, not a service. It exposes exactly two HTTP routes,
 * both defined in `packages/core/src/delivery.ts`:
 *
 *   fileDownloadRoute()   GET       <prefix>/:fileId   (prefix defaults to /files)
 *   shareDownloadRoute()  GET|POST  <prefix>/:secret   (prefix defaults to /d)
 *
 * `deliveryHandler()` mounts the same two under its own defaults, `filePrefix`
 * = /f and `sharePrefix` = /d. The document below is written against /f
 * because that is the prefix `publicUrl()` builds on; mounting
 * `fileDownloadRoute()` directly and leaving `prefix` unset serves /files.
 *
 * `deliveryHandler()` is those two composed, plus a 404 for anything else.
 * Everything else in the product -- uploading, sharing, revoking, membership,
 * reading the audit log -- is an in-process method call with no HTTP binding
 * that we ship. This document describes the two routes that exist and invents
 * nothing. If you are looking for `POST /files`, it does not exist; you call
 * `fl.files.put()` from your own handler.
 *
 * The YAML is emitted with every scalar JSON-encoded. JSON is a subset of
 * YAML 1.2, so this is valid YAML by construction rather than by the care of
 * whoever edited it last.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const VERSION = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8'),
).version;

// -----------------------------------------------------------------------------
// Shared response header descriptions. Every one of these is emitted by
// `deliveryHeaders()`; none of them is optional and none can be turned off.
// -----------------------------------------------------------------------------
const h = (description, schema = { type: 'string' }) => ({ description, schema });

const BYTE_HEADERS = {
  'Content-Type': h(
    'The stored content type, after neutralisation. A type that is not a plausible media type, or that contains CR/LF/NUL, is replaced with application/octet-stream. An active type (html, xml, svg, script, xsl, ecmascript) requested inline is also replaced.',
  ),
  'Content-Disposition': h(
    'RFC 6266, with the filename encoded rather than interpolated. `attachment` by default; forced back to `attachment` for an active content type even when `inline` was configured.',
  ),
  'Content-Length': h(
    'Present when the store reported a length for this response. Recomputed from the response rather than trusted from the metadata row.',
    { type: 'integer' },
  ),
  'X-Content-Type-Options': h('Always `nosniff`.'),
  'Cache-Control': h(
    'Always `private, no-store, no-cache, must-revalidate, max-age=0`. This is what makes immediate revocation true at the browser and at intermediaries, not only at the origin.',
  ),
  Pragma: h('Always `no-cache`. The HTTP/1.0 spelling, because corporate proxies are real.'),
  Expires: h('Always `0`.'),
  'Referrer-Policy': h(
    'Always `no-referrer`. A share link secret is in the URL, so any outbound link inside a delivered document would otherwise leak it in the Referer header.',
  ),
  'Content-Security-Policy': h("Always `default-src 'none'; sandbox`."),
  'X-Frame-Options': h('Always `DENY`.'),
  'X-Filelayer-Delivery': h(
    'Which delivery mode answered this request: `proxy` or `redirect`.',
    { type: 'string', enum: ['proxy', 'redirect'] },
  ),
};

const REDIRECT_HEADERS = {
  Location: h('A short-lived presigned URL at the object store.', {
    type: 'string',
    format: 'uri',
  }),
  'Cache-Control': h(
    'For a delivery authorized by an ANONYMOUS grant: `public, max-age=<half the presigned TTL>`. Half, so a cached 302 never hands a client a URL with milliseconds of life left. For every other grant type: `private, no-store, ...`. Nothing that was not already public becomes cacheable by a shared cache.',
  ),
  'Referrer-Policy': h('Always `no-referrer`. The presigned URL is a credential and it is in `Location`.'),
  'X-Content-Type-Options': h('Always `nosniff`.'),
  'X-Filelayer-Delivery': h('Always `redirect`.', { type: 'string', enum: ['redirect'] }),
};

const ERROR_HEADERS = {
  'Content-Type': h('Always `application/json`.'),
  'Cache-Control': h('Always `private, no-store, no-cache, must-revalidate, max-age=0`.'),
  Pragma: h('Always `no-cache`.'),
  'Referrer-Policy': h('Always `no-referrer`.'),
  'X-Content-Type-Options': h('Always `nosniff`.'),
};

const errorResponse = (description, codes, extra = {}) => ({
  description,
  headers: { ...ERROR_HEADERS, ...(extra.headers ?? {}) },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      ...(extra.example ? { example: extra.example } : { example: { error: codes[0] } }),
    },
  },
  'x-codes': codes,
});

const notFound = errorResponse(
  'Not found — and deliberately indistinguishable from "denied". Internally the exact deny reason is recorded in the audit log; externally every reason that would confirm a file exists collapses to this, so the error surface is not an enumeration oracle across tenants. Covers: no such file, no live grant, a revoked grant, an expired grant, a grant whose download cap is exhausted, an ancestor grant that is no longer live, a forged or unknown share secret, and an `as:` naming an identity the project has never seen.',
  ['not_found'],
);

const gone = errorResponse(
  'The file itself has passed its `expiresAt`. Distinct from a dead grant, which is a 404: the file lifecycle gate runs before the grant decision, and a caller who reaches this has already been authorized.',
  ['gone'],
);

const internal = errorResponse(
  'An unexpected failure. Never a decision — every authorization outcome is one of the statuses above.',
  ['internal'],
);

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Filelayer byte-delivery routes',
    version: VERSION,
    summary: 'The two HTTP routes the Filelayer library serves. There are no others.',
    description: [
      'Filelayer is a Node library, not a hosted service. It ships exactly two HTTP route',
      'handlers, both in `packages/core/src/delivery.ts`, and this document describes those',
      'two and nothing else.',
      '',
      'Everything else in the product — uploading bytes, creating and revoking shares,',
      'managing membership, reading the audit trail — is an in-process method call',
      '(`fl.files.put()`, `fl.shares.create()`, `fl.orgs.audit()`, …) with no HTTP binding',
      'that we ship. You mount those in your own framework, under your own paths, behind',
      'your own authentication. If you are looking for `POST /files` in this document, it is',
      'absent because it does not exist.',
      '',
      'The two routes below exist as routes rather than as response helpers because both',
      'carry a security decision that belongs to the library:',
      '',
      '- the response headers are computed from the file record and cannot be turned off, so',
      '  a developer cannot serve user-uploaded HTML inline from their own origin;',
      '- the share route reads the password from the request body and refuses, with 400,',
      '  if any credential appears in the query string — a routing decision, not a response',
      '  decision, and the reason this is a route.',
      '',
      'Mount them with `deliveryHandler(fl)`, which is both routes plus a 404 for anything',
      'else, and is a complete `node:http` request listener.',
    ].join('\n'),
    license: {
      name: 'Apache-2.0',
      identifier: 'Apache-2.0',
      url: 'https://github.com/filelayer/filelayer/blob/main/LICENSE',
    },
    contact: {
      name: 'Filelayer issues',
      url: 'https://github.com/filelayer/filelayer/issues',
    },
    'x-status':
      'Alpha / developer preview. Pre-1.0: these paths, status codes and headers may change in any 0.x → 0.(x+1) release. See https://github.com/filelayer/filelayer#readme.',
    'x-authentication': [
      'This document declares `security: []` — no security scheme — and that is accurate',
      'rather than an omission. Neither route authenticates the way OpenAPI can describe.',
      '',
      'GET /f/{fileId}: the caller identity comes from YOUR `principal(req)` callback, which',
      'runs before the handler. The mechanism is entirely your choice — session cookie,',
      'bearer token, mTLS, a header from your gateway — and Filelayer never guesses it. There',
      'is therefore no scheme for us to declare; declaring one would describe your',
      'application, not this library. Returning `{ actorId: null }` is an anonymous caller,',
      'which can reach only files carrying an explicit `anonymous` grant.',
      '',
      'GET|POST /d/{secret}: the credential IS the path segment, plus an optional password in',
      'the request body. OpenAPI `apiKey` schemes may only sit in a query parameter, a header',
      'or a cookie, so a secret in the path is not expressible as a security scheme at all.',
      'It is documented on the `secret` path parameter instead.',
      '',
      'Authorization — as distinct from authentication — is ours for every request that',
      'reaches these two routes, happens on every request, and is described by the response',
      'codes.',
      '',
      'THE SCOPE OF THAT SENTENCE, STATED PLAINLY, BECAUSE IT IS THE THING AN INTEGRATION',
      'GETS WRONG. Filelayer is authorization middleware, not row-level security. It decides',
      'for calls made through it. Some invariants are refused by database constraints and',
      'triggers and therefore bind every writer, including a `psql` session: cross-tenant',
      'grants, cross-project identities, and delegation that amplifies authority or subject',
      'breadth. All read authorization lives in `authz.ts`. There is no RLS policy in',
      '`schema.sql`, so a client that queries the tables directly is not filtered by',
      'anything and writes no audit event. Filelayer composes with database-level',
      'enforcement; it does not replace it.',
      '',
      'THE PRECONDITION THIS DOCUMENT CANNOT ENFORCE: YOUR OBJECT BUCKET MUST BE PRIVATE.',
      'Storage keys are `orgId/fileId` and are not treated as secrets — that is deliberate',
      '(P2: storage location is never an input to a decision). Filelayer authorizes requests',
      'that reach these routes; it cannot make a public bucket private, and it never sees a',
      'request that goes straight to the object store. If the bucket is world-readable,',
      'nothing in this document applies. See QUICKSTART §7.',
    ].join('\n'),
  },
  // Deliberately empty, not missing. See info.x-authentication.
  security: [],
  externalDocs: {
    description: 'README, quickstart and the exact semantics of every edge',
    url: 'https://github.com/filelayer/filelayer#readme',
  },
  servers: [
    {
      url: '{baseUrl}',
      description:
        'Your own server. Filelayer does not host anything. `baseUrl` is the value passed to the Filelayer constructor, and it must match where you actually mounted the handler — `fl.files.publicUrl()` builds public URLs from it.',
      variables: {
        baseUrl: {
          default: 'http://localhost:3000',
          description: 'The origin your application serves the delivery handler from.',
        },
      },
    },
  ],
  tags: [
    {
      name: 'files',
      description:
        'The authenticated read path. Your application supplies the caller identity; Filelayer makes the decision, writes the audit event, and owns every response header.',
    },
    {
      name: 'shares',
      description:
        'The share-link path. The secret in the URL is the entire credential — there is no session and no identity to supply.',
    },
  ],
  paths: {
    '/f/{fileId}': {
      description:
        'Mounted by `deliveryHandler(fl, { principal })`, whose `filePrefix` option defaults to `/f`. If you mount `fileDownloadRoute(fl, { principal })` directly, its own `prefix` option defaults to `/files`, not `/f` -- pass `prefix: \'/f\'` to serve the path documented here. Whichever you choose, `publicUrl()` always builds on `/f`, so keep `baseUrl` and the mounted prefix consistent with it.',
      get: {
        tags: ['files'],
        operationId: 'readFile',
        summary: 'Read a file, if the caller is allowed to.',
        description: [
          'Re-authorizes on **every** request. That is the whole design: revocation beats a',
          'live URL because there is a decision at each request to revoke against.',
          '',
          'Identity is whatever your `principal(req)` callback returns — Filelayer never',
          'guesses it from a cookie or a header. If you mount the handler without a',
          '`principal` callback every request is anonymous, which is safe but not a "public',
          'mode": through this route, an anonymous caller reaches only a file carrying an',
          'explicit `anonymous` grant. There is no public mode and no `public` column.',
          '',
          'That is true of this route. It is not true of your object store: keys are',
          '`orgId/fileId` and P2 does not treat them as secrets, so the bucket must be',
          'private or this route is not the only way in.',
          '',
          'This is also the URL returned by `fl.files.put(bytes, { public: true })` and',
          '`fl.files.publish()`. Calling `fl.files.unpublish()` makes it start returning 404',
          'on the very next request, with no deletion, no key rotation and no cache purge.',
        ].join('\n'),
        parameters: [
          {
            name: 'fileId',
            in: 'path',
            required: true,
            description:
              'The opaque file id returned by `put()`. Knowing it grants nothing (P2): it is not an input to any decision.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: {
            description:
              'The bytes, streamed, with the full header set. Nothing is buffered in the serving process.',
            headers: BYTE_HEADERS,
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          302: {
            description:
              'Redirect delivery. Only emitted when the instance was configured with `redirectDelivery` AND the verbatim acknowledgement string was supplied; by default only anonymous (published) grants are eligible. Revocation is immediate at decision time plus up to `ttlSeconds` of in-flight window, and `ttlSeconds` is clamped to 300.',
            headers: REDIRECT_HEADERS,
          },
          404: notFound,
          410: gone,
          500: internal,
        },
      },
    },
    '/d/{secret}': {
      description:
        'Mounted by `shareDownloadRoute(fl)`, or by `deliveryHandler(fl)`. The `/d` prefix is the default and is configurable via `sharePrefix`.',
      parameters: [
        {
          name: 'secret',
          in: 'path',
          required: true,
          description:
            'The share secret returned exactly once by `fl.shares.create()`. Only its SHA-256 is stored, so it cannot be recovered from the database. It is the entire credential: possession is authorization, attenuated by the grant it was minted from.',
          schema: { type: 'string' },
        },
      ],
      get: {
        tags: ['shares'],
        operationId: 'redeemShare',
        summary: 'Redeem a share link that has no password.',
        description: [
          'Consumes one download against the grant cap, atomically, and only when bytes',
          'actually leave — a metadata lookup does not spend one.',
          '',
          'If the link is password protected this returns **401** with',
          '`WWW-Authenticate: FilelayerShare`. Re-issue the identical request as a POST with',
          'the password in the body. There is no supported way to put a password in the URL,',
          'and attempting it is a 400 rather than a silent success.',
        ].join('\n'),
        responses: {
          200: {
            description: 'The bytes, streamed, with the full header set.',
            headers: {
              ...BYTE_HEADERS,
              'X-Downloads-Remaining': h(
                'Downloads left on this grant after this one, or empty when the grant is uncapped. Safe to expose: the recipient already holds the credential it counts against.',
              ),
            },
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          302: {
            description:
              'Redirect delivery. See the note on `GET /f/{fileId}`. Not eligible by default for a link grant — the default scope is anonymous grants only.',
            headers: REDIRECT_HEADERS,
          },
          400: errorResponse(
            'A credential was present in the query string. Refused before any work is done and without consuming a download. The refused keys are `password`, `pw`, `pass`, `passwd`, `token`, `secret` and `key`. (`secret` as the path segment is fine — that is the design; it is the query string that ends up in access logs, proxy logs and browser history.)',
            ['credential_in_query'],
          ),
          401: errorResponse(
            'This link is password protected. Retry as `POST` with the password in the request body.',
            ['password_required'],
            {
              headers: {
                'WWW-Authenticate': h('Always `FilelayerShare`.'),
              },
              example: {
                error: 'password_required',
                retry: { method: 'POST', field: 'password' },
              },
            },
          ),
          404: notFound,
          410: gone,
          500: internal,
        },
      },
      post: {
        tags: ['shares'],
        operationId: 'redeemShareWithPassword',
        summary: 'Redeem a share link, supplying the password in the body.',
        description:
          'Identical to the GET in every respect except that the password is read from the request body. The body is capped at 64 KiB. An unparseable JSON body is a 400. A request with no password against a password-protected link is a 401, exactly as the GET is.',
        requestBody: {
          required: false,
          description:
            'Omit entirely for a link with no password. Either encoding is accepted; the password never goes in the query string.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  password: {
                    type: 'string',
                    description: 'The password the link was created with.',
                  },
                },
                additionalProperties: true,
              },
              example: { password: 'hunter2' },
            },
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: { password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The bytes, streamed, with the full header set.',
            headers: {
              ...BYTE_HEADERS,
              'X-Downloads-Remaining': h('See the GET.'),
            },
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          302: {
            description: 'Redirect delivery. See the note on `GET /f/{fileId}`.',
            headers: REDIRECT_HEADERS,
          },
          400: errorResponse(
            'Either a credential appeared in the query string (`credential_in_query`) or the request body was not parseable (`bad_request`).',
            ['credential_in_query', 'bad_request'],
          ),
          401: errorResponse(
            'Missing or wrong password.',
            ['password_required'],
            {
              headers: { 'WWW-Authenticate': h('Always `FilelayerShare`.') },
              example: {
                error: 'password_required',
                retry: { method: 'POST', field: 'password' },
              },
            },
          ),
          404: notFound,
          410: gone,
          413: errorResponse('The request body exceeded 64 KiB.', ['payload_too_large']),
          500: internal,
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        description:
          'Every error on these routes has this shape. `error` is a stable machine-readable code. The internal reason for a denial is deliberately NOT included — it is written to the audit log, where the operator who needs it can see it, and withheld from the caller, who would otherwise be able to distinguish "does not exist" from "you may not have it".',
        properties: {
          error: {
            type: 'string',
            description: 'The stable error code.',
            enum: [
              'not_found',
              'gone',
              'password_required',
              'credential_in_query',
              'bad_request',
              'payload_too_large',
              'internal',
            ],
          },
          retry: {
            type: 'object',
            description: 'Present only on 401. How to re-issue the request successfully.',
            properties: {
              method: { type: 'string', enum: ['POST'] },
              field: { type: 'string', enum: ['password'] },
            },
          },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// Serialisation
// -----------------------------------------------------------------------------

const BANNER_JSON = null; // JSON has no comments; the YAML carries the note.

/** Keys that are safe as plain YAML scalars. Everything else is quoted. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // JSON strings are valid YAML 1.2 double-quoted scalars, escapes included.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((v) => {
        const rendered = toYaml(v, indent + 2);
        const isBlock = (Array.isArray(v) || (v && typeof v === 'object')) && rendered !== '{}' && rendered !== '[]';
        return isBlock ? `${pad}- ${rendered.slice(indent + 2)}` : `${pad}- ${rendered}`;
      })
      .join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      const key = PLAIN_KEY.test(k) ? k : JSON.stringify(k);
      const rendered = toYaml(v, indent + 2);
      const isBlock =
        (Array.isArray(v) || (v && typeof v === 'object')) && rendered !== '{}' && rendered !== '[]';
      if (!isBlock) return `${pad}${key}: ${rendered}`;
      return `${pad}${key}:\n${rendered}`;
    })
    .join('\n');
}

const YAML_HEADER = `# Filelayer — the HTTP surface the library actually serves.
#
# GENERATED FILE. Do not edit: run \`npm run openapi\` (tools/openapi.mjs), which
# is the single source for both openapi.yaml and openapi.json. CI fails if
# either is stale.
#
# Scope: two routes, from packages/core/src/delivery.ts. Everything else in
# Filelayer is an in-process library call with no HTTP binding that we ship.
`;

const json = JSON.stringify(spec, null, 2) + '\n';
const yaml = YAML_HEADER + toYaml(spec) + '\n';

const targets = [
  [join(ROOT, 'openapi.json'), json],
  [join(ROOT, 'openapi.yaml'), yaml],
];

if (process.argv.includes('--check')) {
  const stale = targets.filter(([p, want]) => !existsSync(p) || readFileSync(p, 'utf8') !== want);
  if (stale.length > 0) {
    console.error('\nopenapi: STALE\n');
    for (const [p] of stale) console.error('  ' + p.replace(ROOT + '/', '') + ' does not match tools/openapi.mjs');
    console.error('\nRun `npm run openapi` and commit the result.\n');
    process.exit(1);
  }
  console.log('openapi: openapi.json and openapi.yaml are up to date.');
  process.exit(0);
}

for (const [p, content] of targets) {
  writeFileSync(p, content);
  console.log('openapi: wrote ' + p.replace(ROOT + '/', '') + ' (' + content.length + ' bytes)');
}
void BANNER_JSON;
