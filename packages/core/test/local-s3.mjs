/**
 * TEST HARNESS -- NOT APPLICATION CODE. Excluded from all LOC counts.
 *
 * A local S3-protocol object store that performs REAL AWS Signature Version 4
 * verification of both header-signed and presigned requests, and implements
 * enough of the API surface that `S3Storage` can be exercised end to end
 * without credentials:
 *
 *   PUT / GET / HEAD / DELETE, ranged GET (206 + Content-Range, 416),
 *   ListObjectsV2 with continuation tokens,
 *   CreateMultipartUpload / UploadPart / CompleteMultipartUpload /
 *   AbortMultipartUpload,
 *   presigned GET including expiry, response-content-type and
 *   response-content-disposition overrides.
 *
 * WHAT MAKES IT WORTH ANYTHING. It recomputes the signature from the request as
 * RECEIVED -- the raw encoded path, the raw query string, the actual header
 * values named in SignedHeaders -- and returns 403 SignatureDoesNotMatch on any
 * mismatch. It also verifies that `x-amz-content-sha256` matches the body that
 * actually arrived. A client that signs one string and sends another fails here
 * exactly as it would fail against AWS.
 *
 * It also enforces the rules that bite in production and never bite in a mock:
 *   - every part except the last must be >= 5 MiB (EntityTooSmall)
 *   - completing with an ETag that does not match the stored part is InvalidPart
 *   - an unknown uploadId is NoSuchUpload
 *   - an expired presigned URL is AccessDenied
 *   - a request with no date or a skewed date is RequestTimeTooSkewed
 *
 * DERIVED FROM an earlier S3 test harness in this repository, which verified
 * presigned signatures only and stubbed header-signed ones. That gap is exactly
 * where our adapter's bugs were, so it is closed here.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const ALGO = 'AWS4-HMAC-SHA256';
const MIN_PART = 5 * 1024 * 1024;
const MAX_SKEW_MS = 15 * 60 * 1000;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const signingKey = (secret, date, region, service) =>
  hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');

const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Sorted, re-encoded canonical query string, derived from the RAW query. */
function canonicalQuery(rawQuery) {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = i < 0 ? pair : pair.slice(0, i);
      const v = i < 0 ? '' : pair.slice(i + 1);
      return [rfc3986(decodeURIComponent(k)), rfc3986(decodeURIComponent(v))];
    })
    .filter(([k]) => k !== 'X-Amz-Signature')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function parseAmzDate(amzDate) {
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return NaN;
  return Date.UTC(
    +amzDate.slice(0, 4),
    +amzDate.slice(4, 6) - 1,
    +amzDate.slice(6, 8),
    +amzDate.slice(9, 11),
    +amzDate.slice(11, 13),
    +amzDate.slice(13, 15),
  );
}

export function createLocalS3({ accessKeyId, secretAccessKey, bucket = 'test-bucket', now = Date.now } = {}) {
  /** @type {Map<string, {body: Buffer, contentType: string, lastModified: Date}>} */
  const objects = new Map();
  /** @type {Map<string, {key: string, contentType: string, parts: Map<number,{body:Buffer,etag:string}>}>} */
  const uploads = new Map();
  const credentials = new Map([[accessKeyId, { secretAccessKey, active: true }]]);
  const requestLog = [];
  /** Faults the test can inject, e.g. { key: 'a/b', method: 'PUT', status: 500, code: 'InternalError' } */
  let faults = [];

  const etagOf = (buf) => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

  /** Recompute the signature over the request AS RECEIVED. */
  function verify(req, rawPath, rawQuery, body) {
    const q = new URLSearchParams(rawQuery);
    const presigned = q.has('X-Amz-Signature');

    let credential, amzDate, signedHeaders, signature, payloadHash;
    if (presigned) {
      credential = q.get('X-Amz-Credential') ?? '';
      amzDate = q.get('X-Amz-Date') ?? '';
      signedHeaders = q.get('X-Amz-SignedHeaders') ?? 'host';
      signature = q.get('X-Amz-Signature');
      payloadHash = 'UNSIGNED-PAYLOAD';
      if (q.get('X-Amz-Algorithm') !== ALGO) return { code: 'InvalidRequest', status: 400 };
    } else {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith(ALGO + ' ')) return { code: 'AccessDenied', status: 403 };
      const cred = /Credential=([^,\s]+)/.exec(auth);
      const sh = /SignedHeaders=([^,\s]+)/.exec(auth);
      const sig = /Signature=([0-9a-f]+)/.exec(auth);
      if (!cred || !sh || !sig) return { code: 'AuthorizationHeaderMalformed', status: 400 };
      credential = cred[1];
      signedHeaders = sh[1];
      signature = sig[1];
      amzDate = String(req.headers['x-amz-date'] ?? '');
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
      if (!payloadHash) return { code: 'MissingSecurityHeader', status: 400 };
      // Real S3 rejects a body that does not match the declared payload hash.
      if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256hex(body)) {
        return { code: 'XAmzContentSHA256Mismatch', status: 400 };
      }
    }

    const [keyId, dateStamp, credRegion, service] = String(credential).split('/');
    const c = credentials.get(keyId);
    if (!c || !c.active) return { code: 'InvalidAccessKeyId', status: 403 };

    const signedAt = parseAmzDate(amzDate);
    if (Number.isNaN(signedAt)) return { code: 'AuthorizationHeaderMalformed', status: 400 };
    if (presigned) {
      const expires = parseInt(q.get('X-Amz-Expires') ?? '0', 10);
      if (now() > signedAt + expires * 1000) return { code: 'AccessDenied', status: 403, expired: true };
    } else if (Math.abs(now() - signedAt) > MAX_SKEW_MS) {
      return { code: 'RequestTimeTooSkewed', status: 403 };
    }

    // `host` must be verified against what the client actually sent, because
    // that is what AWS does and it is how a virtual-host/path-style mix-up is
    // caught.
    const canonicalHeaders = String(signedHeaders)
      .split(';')
      .map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`)
      .join('');

    const canonicalRequest = [
      req.method,
      rawPath,
      canonicalQuery(rawQuery),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${credRegion}/${service}/aws4_request`;
    const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const expected = crypto
      .createHmac('sha256', signingKey(c.secretAccessKey, dateStamp, credRegion, service))
      .update(stringToSign, 'utf8')
      .digest('hex');

    if (expected !== signature) {
      return { code: 'SignatureDoesNotMatch', status: 403, canonicalRequest, expected, got: signature };
    }
    return { ok: true, presigned, query: q };
  }

  const server = http.createServer((req, res) => {
    const qIndex = (req.url ?? '').indexOf('?');
    const rawPath = qIndex < 0 ? req.url : req.url.slice(0, qIndex);
    const rawQuery = qIndex < 0 ? '' : req.url.slice(qIndex + 1);

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        handle(req, res, rawPath, rawQuery, body);
      } catch (err) {
        xml(res, 500, 'InternalError', String(err && err.message));
      }
    });
  });

  function xml(res, status, code, message = '') {
    const b = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    );
    res.writeHead(status, { 'content-type': 'application/xml', 'content-length': String(b.length) });
    res.end(b);
  }

  function handle(req, res, rawPath, rawQuery, body) {
    // Path-style: /<bucket>/<key...>
    const decodedPath = decodeURIComponent(rawPath);
    const segs = decodedPath.replace(/^\//, '').split('/');
    const reqBucket = segs.shift();
    const key = segs.join('/');
    const q = new URLSearchParams(rawQuery);

    requestLog.push({
      method: req.method,
      key,
      query: Object.fromEntries(q.entries()),
      presigned: q.has('X-Amz-Signature'),
      at: now(),
    });

    const v = verify(req, rawPath, rawQuery, body);
    if (!v.ok) {
      if (v.code === 'SignatureDoesNotMatch') {
        // Surfaced to the test runner, because a silent 403 in a signing test is
        // an afternoon lost.
        server.emit('sigfail', v);
      }
      return xml(res, v.status, v.code, v.canonicalRequest ? 'canonical request mismatch' : '');
    }
    if (reqBucket !== bucket) return xml(res, 404, 'NoSuchBucket', reqBucket ?? '');

    for (const f of faults) {
      if ((f.key === undefined || f.key === key) && (f.method === undefined || f.method === req.method)) {
        return xml(res, f.status ?? 500, f.code ?? 'InternalError', 'injected fault');
      }
    }

    // --- ListObjectsV2 ------------------------------------------------------
    if (req.method === 'GET' && key === '' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const max = Math.min(Number(q.get('max-keys') ?? 1000), 1000);
      const after = q.get('continuation-token') ?? '';
      const all = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix) && k > after)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const page = all.slice(0, max);
      const truncated = all.length > max;
      const b = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          `<Name>${bucket}</Name><Prefix>${prefix}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${page[page.length - 1][0]}</NextContinuationToken>` : '') +
          page
            .map(
              ([k, o]) =>
                `<Contents><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key>` +
                `<LastModified>${o.lastModified.toISOString()}</LastModified>` +
                `<ETag>${etagOf(o.body).replace(/"/g, '&quot;')}</ETag>` +
                `<Size>${o.body.length}</Size></Contents>`,
            )
            .join('') +
          `</ListBucketResult>`,
      );
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(b.length) });
      return res.end(b);
    }

    // --- Multipart ----------------------------------------------------------
    if (req.method === 'POST' && q.has('uploads')) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, {
        key,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        parts: new Map(),
      });
      const b = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
          `<Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
          `</InitiateMultipartUploadResult>`,
      );
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(b.length) });
      return res.end(b);
    }

    if (req.method === 'PUT' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId'));
      if (!up) return xml(res, 404, 'NoSuchUpload');
      const n = Number(q.get('partNumber'));
      if (!Number.isInteger(n) || n < 1 || n > 10000) return xml(res, 400, 'InvalidArgument');
      const etag = etagOf(body);
      up.parts.set(n, { body, etag });
      res.writeHead(200, { ETag: etag, 'content-length': '0' });
      return res.end();
    }

    if (req.method === 'DELETE' && q.has('uploadId')) {
      uploads.delete(q.get('uploadId'));
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'POST' && q.has('uploadId')) {
      const uploadId = q.get('uploadId');
      const up = uploads.get(uploadId);
      if (!up) return xml(res, 404, 'NoSuchUpload');
      const doc = body.toString('utf8');
      const listed = [...doc.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag><\/Part>/g)].map(
        (m) => ({ n: Number(m[1]), etag: m[2].replace(/&quot;/g, '"') }),
      );
      if (listed.length === 0) return xml(res, 400, 'MalformedXML');
      for (let i = 1; i < listed.length; i++) {
        if (listed[i].n <= listed[i - 1].n) return xml(res, 400, 'InvalidPartOrder');
      }
      const buffers = [];
      for (let i = 0; i < listed.length; i++) {
        const p = up.parts.get(listed[i].n);
        if (!p) return xml(res, 400, 'InvalidPart', `part ${listed[i].n}`);
        if (p.etag !== listed[i].etag) return xml(res, 400, 'InvalidPart', 'etag mismatch');
        // The rule that only ever fires in production.
        if (i < listed.length - 1 && p.body.length < MIN_PART) {
          return xml(res, 400, 'EntityTooSmall', `part ${listed[i].n} is ${p.body.length} bytes`);
        }
        buffers.push(p.body);
      }
      const full = Buffer.concat(buffers);
      objects.set(up.key, { body: full, contentType: up.contentType, lastModified: new Date(now()) });
      uploads.delete(uploadId);
      const b = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
          `<Location>http://localhost/${bucket}/${up.key}</Location><Bucket>${bucket}</Bucket>` +
          `<Key>${up.key}</Key><ETag>&quot;${crypto.createHash('md5').update(full).digest('hex')}-${listed.length}&quot;</ETag>` +
          `</CompleteMultipartUploadResult>`,
      );
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(b.length) });
      return res.end(b);
    }

    // --- Single-object operations ------------------------------------------
    if (req.method === 'PUT') {
      objects.set(key, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        lastModified: new Date(now()),
      });
      res.writeHead(200, { ETag: etagOf(body), 'content-length': '0' });
      return res.end();
    }

    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }

    const obj = objects.get(key);
    if (!obj) return xml(res, 404, 'NoSuchKey', key);

    // Presigned response-header overrides: the store, not the client, decides.
    const ct = v.presigned ? (v.query.get('response-content-type') ?? obj.contentType) : obj.contentType;
    const cd = v.presigned ? v.query.get('response-content-disposition') : null;

    const range = String(req.headers.range ?? '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const total = obj.body.length;
      let start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
      let end = m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Number(m[2]);
      if (Number.isNaN(start) || start >= total || start < 0) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      const slice = obj.body.subarray(start, end + 1);
      const headers = {
        'content-type': ct,
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${end}/${total}`,
        ETag: etagOf(obj.body),
        'last-modified': obj.lastModified.toUTCString(),
      };
      if (cd) headers['content-disposition'] = cd;
      res.writeHead(206, headers);
      return req.method === 'HEAD' ? res.end() : res.end(slice);
    }

    const headers = {
      'content-type': ct,
      'content-length': String(obj.body.length),
      ETag: etagOf(obj.body),
      'last-modified': obj.lastModified.toUTCString(),
      'accept-ranges': 'bytes',
    };
    if (cd) headers['content-disposition'] = cd;
    res.writeHead(200, headers);
    return req.method === 'HEAD' ? res.end() : res.end(obj.body);
  }

  return {
    server,
    objects,
    uploads,
    requestLog,
    listen: (port = 0) =>
      new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
    endpoint: () => `http://127.0.0.1:${server.address().port}`,
    bucket,
    deactivateAccessKey: (id) => { credentials.get(id).active = false; },
    activateAccessKey: (id) => { credentials.get(id).active = true; },
    injectFault: (f) => { faults.push(f); },
    clearFaults: () => { faults = []; },
  };
}
