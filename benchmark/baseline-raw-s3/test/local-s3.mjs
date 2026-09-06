/**
 * TEST HARNESS — NOT APPLICATION CODE. Excluded from all LOC counts.
 *
 * A minimal S3-compatible object store that performs REAL AWS Signature
 * Version 4 verification of presigned query-string URLs, including expiry
 * enforcement. This exists so the benchmark can prove presigned-URL
 * semantics (in particular: that the object store has no knowledge of the
 * application's share/revocation state) without network access to AWS/R2.
 *
 * Fidelity notes:
 *  - Presigned (query-string) requests: signature + expiry are fully verified.
 *  - Header-signed (SDK GetObject/HeadObject/DeleteObject) requests:
 *    credential-scope presence and key activation are checked; the signature
 *    is not recomputed. Those are made by the application's own IAM principal
 *    and are not the subject of the benchmark.
 *  - Supports the "revoke/deactivate the signing credential" mitigation that
 *    AWS documents as the only way to kill an already-issued presigned URL,
 *    via `deactivateAccessKey()`, so the benchmark can measure what that
 *    actually buys you.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const ALGO = 'AWS4-HMAC-SHA256';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}
function rfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}
function encodePath(p) {
  return p.split('/').map(rfc3986).join('/');
}

export function createLocalS3({ accessKeyId, secretAccessKey }) {
  /** @type {Map<string, {body: Buffer, contentType: string}>} */
  const objects = new Map();
  const credentials = new Map([[accessKeyId, { secretAccessKey, active: true }]]);
  const requestLog = [];

  function verifyPresigned(req, url) {
    const q = url.searchParams;
    const signature = q.get('X-Amz-Signature');
    const credential = q.get('X-Amz-Credential') ?? '';
    const amzDate = q.get('X-Amz-Date') ?? '';
    const expires = parseInt(q.get('X-Amz-Expires') ?? '0', 10);
    const signedHeaders = q.get('X-Amz-SignedHeaders') ?? 'host';

    if (q.get('X-Amz-Algorithm') !== ALGO) return { ok: false, code: 'InvalidRequest' };

    const [keyId, dateStamp, credRegion, service] = credential.split('/');
    const cred = credentials.get(keyId);
    // AWS: "a presigned URL expires when the credential used to create it is
    // revoked, deleted, or deactivated." This is the ONLY revocation lever.
    if (!cred || !cred.active) return { ok: false, code: 'InvalidAccessKeyId' };

    const signedAt = Date.UTC(
      +amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8),
      +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15)
    );
    if (Date.now() > signedAt + expires * 1000) {
      return { ok: false, code: 'AccessDenied' };
    }

    const canonicalQuery = [...q.entries()]
      .filter(([k]) => k !== 'X-Amz-Signature')
      .map(([k, v]) => [rfc3986(k), rfc3986(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const canonicalHeaders = signedHeaders
      .split(';')
      .map((h) => `${h}:${(req.headers[h] ?? '').toString().trim()}\n`)
      .join('');

    const canonicalRequest = [
      req.method,
      encodePath(decodeURIComponent(url.pathname)),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const scope = `${dateStamp}/${credRegion}/${service}/aws4_request`;
    const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const expected = crypto
      .createHmac('sha256', signingKey(cred.secretAccessKey, dateStamp, credRegion, service))
      .update(stringToSign, 'utf8')
      .digest('hex');

    if (expected !== signature) return { ok: false, code: 'SignatureDoesNotMatch' };
    return { ok: true };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = decodeURIComponent(url.pathname).replace(/^\//, '');
    const presigned = url.searchParams.has('X-Amz-Signature');
    requestLog.push({ method: req.method, key, presigned, at: Date.now() });

    const deny = (code, status = 403) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
    };

    if (presigned) {
      const v = verifyPresigned(req, url);
      if (!v.ok) return deny(v.code);
    } else {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith(ALGO)) return deny('AccessDenied');
      const m = /Credential=([^/]+)\//.exec(auth);
      const cred = m && credentials.get(m[1]);
      if (!cred || !cred.active) return deny('InvalidAccessKeyId');
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        objects.set(key, {
          body,
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
        });
        res.writeHead(200, { ETag: `"${sha256hex(body).slice(0, 32)}"` });
        res.end();
      });
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const obj = objects.get(key);
    if (!obj) return deny('NoSuchKey', 404);
    const headers = {
      'content-type': obj.contentType,
      'content-length': String(obj.body.length),
      ETag: `"${sha256hex(obj.body).slice(0, 32)}"`,
      'last-modified': new Date().toUTCString(),
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    res.writeHead(200, headers);
    res.end(obj.body);
  });

  return {
    server,
    objects,
    requestLog,
    listen: (port = 0) =>
      new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
    deactivateAccessKey: (id) => { credentials.get(id).active = false; },
    activateAccessKey: (id) => { credentials.get(id).active = true; },
  };
}
