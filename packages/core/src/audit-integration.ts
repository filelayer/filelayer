/**
 * DOES *YOUR* FILE ROUTE HOLD THE PROPERTIES THIS LIBRARY IS SOLD ON?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Everything else this project ships that you can run checks US. The suite
 * checks the library. `examples/starter/verify.mjs` checks the starter, and
 * hard-codes the starter's routes. The guide proofs check the guides. All of
 * them answer "is Filelayer correct", which is a question you were not asking.
 *
 * The question you are asking is "is MY application correct", and nothing
 * answered it. You can mount this library perfectly and still leak files,
 * because the leak is usually in the code around it: a route that falls
 * through to a 200, a listing endpoint that filters after fetching, a signed
 * URL handed out beside the authorized one, a reverse proxy that caches a
 * response marked `no-store`.
 *
 * So this takes YOUR application, through callbacks you write, and checks the
 * properties against it. It knows nothing about your framework, your routes or
 * your session format. It does not import your code. It makes requests and
 * reads answers.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PASS MEANS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * A pass means the properties below held for the requests this made. It is not
 * a security audit, it does not look at your code, and it cannot find a hole in
 * a path it was not told about. A failure, on the other hand, is real: it is a
 * request that got an answer it should not have.
 *
 * Every check says what it did, so a result you disagree with can be argued
 * with rather than taken on faith.
 */

/** One request, as your application answers it. */
export interface AuditResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * The four things this needs to be able to do to your application. Write them
 * against your own routes; they are the only place your framework appears.
 */
export interface IntegrationUnderTest {
  /**
   * Store `body` as `owner` and return the id and the URL your application
   * serves it from. However your upload endpoint works.
   */
  upload(input: {
    owner: string;
    name: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<{ id: string; url: string }>;

  /**
   * GET `url` as `who`, or anonymously when `who` is null. Attach whatever
   * your session needs: a cookie, a bearer token, a header.
   *
   * MUST NOT THROW ON A 4xx. Return the response. A client that throws on 404
   * cannot tell this harness the difference between "refused" and "your test
   * client is broken", and that difference is most of what is being measured.
   */
  get(url: string, who: string | null, extraHeaders?: Record<string, string>): Promise<AuditResponse>;

  /** Grant `user` read access to the file. Omit to skip the revocation checks. */
  share?(id: string, user: string): Promise<void>;
  /** Remove that access again. Required if `share` is given. */
  unshare?(id: string, user: string): Promise<void>;

  /**
   * A user id your application has NEVER seen. Defaults to a random one.
   * Override if your authentication rejects unknown ids before they reach
   * Filelayer, which is fine and worth knowing.
   */
  unknownUser?: string;
}

export interface AuditCheck {
  name: string;
  /** `fail` is a request that got an answer it should not have. */
  outcome: 'pass' | 'fail' | 'skipped';
  /** What was done and what came back, so the verdict can be argued with. */
  detail: string;
  /** Why it matters, on a failure. Absent on a pass. */
  why?: string;
}

export interface AuditReport {
  checks: AuditCheck[];
  passed: number;
  failed: number;
  skipped: number;
  /** True when nothing failed. Skips do not fail a run. */
  ok: boolean;
}

const BODY = new TextEncoder().encode('AUDIT BODY, 26 chars long.');

/**
 * Run the checks against a live application.
 *
 *     const report = await auditIntegration({
 *       owner: 'alice', stranger: 'bob',
 *       app: { upload, get, share, unshare },
 *     });
 *     if (!report.ok) process.exit(1);
 *
 * `owner` and `stranger` must be two ids your application knows and that are
 * NOT the same person. The stranger must have no access to the owner's files;
 * if your application gives everybody access to everything on purpose, this
 * harness has nothing to tell you.
 */
export async function auditIntegration(cfg: {
  owner: string;
  stranger: string;
  app: IntegrationUnderTest;
}): Promise<AuditReport> {
  const { app } = cfg;
  const checks: AuditCheck[] = [];
  const add = (name: string, outcome: AuditCheck['outcome'], detail: string, why?: string) => {
    checks.push(why === undefined ? { name, outcome, detail } : { name, outcome, detail, why });
  };

  const text = (r: AuditResponse) => new TextDecoder().decode(r.body);
  const header = (r: AuditResponse, k: string) => r.headers[k.toLowerCase()] ?? r.headers[k] ?? '';

  // ---------------------------------------------------------------------------
  // Setup. A failure here is not a finding about your application, it is this
  // harness being unable to start, and it says so.
  // ---------------------------------------------------------------------------
  let file: { id: string; url: string };
  try {
    file = await app.upload({
      owner: cfg.owner,
      name: 'filelayer-audit.txt',
      contentType: 'text/plain',
      body: BODY,
    });
  } catch (err) {
    add(
      'the harness can upload a file',
      'fail',
      `upload() threw: ${err instanceof Error ? err.message : String(err)}`,
      'Nothing below could run. This is a problem with the callbacks, not a finding about your application.',
    );
    return summarise(checks);
  }

  // ---------------------------------------------------------------------------
  // 1. The owner can read their own file. If this fails, everything after it
  //    would "pass" for the wrong reason: a route that refuses everybody looks
  //    identical to a route that refuses the right people.
  // ---------------------------------------------------------------------------
  const own = await app.get(file.url, cfg.owner);
  if (own.status === 200 && text(own) === new TextDecoder().decode(BODY)) {
    add('the owner reads their own file', 'pass', `GET as ${cfg.owner} -> 200, bytes match`);
  } else {
    add(
      'the owner reads their own file',
      'fail',
      `GET as ${cfg.owner} -> ${own.status}, ${own.body.byteLength} byte(s)`,
      'Every refusal check below is meaningless until this passes: a route that refuses everybody passes them all.',
    );
    return summarise(checks);
  }

  // ---------------------------------------------------------------------------
  // 2. A stranger is refused. The headline property.
  // ---------------------------------------------------------------------------
  const stranger = await app.get(file.url, cfg.stranger);
  if (stranger.status === 200) {
    add(
      'a stranger cannot read it',
      'fail',
      `GET as ${cfg.stranger} -> 200, ${stranger.body.byteLength} byte(s) served`,
      'Another user read a file that is not theirs. Everything else is secondary to this.',
    );
  } else if (stranger.status === 404) {
    add('a stranger cannot read it', 'pass', `GET as ${cfg.stranger} -> 404`);
  } else if (stranger.status === 403) {
    add(
      'a stranger is refused WITHOUT confirming the file exists',
      'fail',
      `GET as ${cfg.stranger} -> 403`,
      'A 403 says "this exists and you may not have it". That is a membership oracle: a stranger can ' +
        'enumerate which ids are real by watching 403 against 404. Answer 404 for both.',
    );
  } else {
    add('a stranger cannot read it', 'pass', `GET as ${cfg.stranger} -> ${stranger.status}`);
  }

  // ---------------------------------------------------------------------------
  // 3. Anonymous is refused.
  // ---------------------------------------------------------------------------
  const anon = await app.get(file.url, null);
  if (anon.status === 200) {
    add(
      'an anonymous caller cannot read it',
      'fail',
      `GET with no identity -> 200, ${anon.body.byteLength} byte(s) served`,
      'The file is public. If that is deliberate, this check is not for you; if it is not, the route is ' +
        'falling through to an unauthenticated path.',
    );
  } else {
    add('an anonymous caller cannot read it', 'pass', `GET with no identity -> ${anon.status}`);
  }

  // ---------------------------------------------------------------------------
  // 4. An id nobody has ever seen DENIES rather than degrading to anonymous.
  //
  //    This is the one that catches a session lookup returning undefined and
  //    the route treating that as "no user", which is a typo away from serving
  //    every public file to anybody.
  // ---------------------------------------------------------------------------
  const unknown = app.unknownUser ?? `audit-unknown-${Math.random().toString(36).slice(2, 10)}`;
  const ghost = await app.get(file.url, unknown);
  if (ghost.status === 200) {
    add(
      'an unknown user id denies rather than degrading to anonymous',
      'fail',
      `GET as "${unknown}" -> 200`,
      'An id your application has never seen was served the file. A failed session lookup must deny, ' +
        'never fall back to an anonymous or default identity.',
    );
  } else {
    add(
      'an unknown user id denies rather than degrading to anonymous',
      'pass',
      `GET as "${unknown}" -> ${ghost.status}`,
    );
  }

  // ---------------------------------------------------------------------------
  // 5. The bytes are not served as something a browser will run.
  // ---------------------------------------------------------------------------
  const nosniff = header(own, 'x-content-type-options');
  if (nosniff.toLowerCase() === 'nosniff') {
    add('user content is served with X-Content-Type-Options: nosniff', 'pass', 'header present');
  } else {
    add(
      'user content is served with X-Content-Type-Options: nosniff',
      'fail',
      `X-Content-Type-Options: ${nosniff || '(absent)'}`,
      'Without it a browser may sniff an uploaded file as HTML and run it on your origin, with your ' +
        "users' cookies in scope.",
    );
  }

  const disposition = header(own, 'content-disposition');
  if (/^attachment/i.test(disposition)) {
    add('user content is served as an attachment', 'pass', disposition.slice(0, 60));
  } else {
    add(
      'user content is served as an attachment',
      'fail',
      `Content-Disposition: ${disposition || '(absent)'}`,
      'Serving user content inline from your own origin is stored XSS if the sniffing is ever wrong. ' +
        'If you must render inline, serve it from a different origin.',
    );
  }

  // ---------------------------------------------------------------------------
  // 6. Range. Only meaningful if the route answers ranges at all; a route that
  //    ignores them entirely is allowed, and is reported as such rather than
  //    as a failure.
  // ---------------------------------------------------------------------------
  const ranged = await app.get(file.url, cfg.owner, { range: 'bytes=0-4' });
  if (ranged.status === 206) {
    const cr = header(ranged, 'content-range');
    const bytes = text(ranged);
    if (bytes === 'AUDIT' && /^bytes 0-4\/\d+$/.test(cr)) {
      add('a byte range is answered correctly', 'pass', `206, ${cr}, "${bytes}"`);
    } else {
      add(
        'a byte range is answered correctly',
        'fail',
        `206, Content-Range: ${cr || '(absent)'}, body "${bytes}"`,
        'A 206 whose body or Content-Range does not match the request corrupts the file the client ' +
          'assembles, with no error anywhere.',
      );
    }

    const invalid = await app.get(file.url, cfg.owner, { range: 'bytes=9-4' });
    if (invalid.status === 416) {
      add(
        'an INVALID range is ignored rather than refused',
        'fail',
        'Range: bytes=9-4 -> 416',
        'RFC 9110 says an invalid range must be ignored and the whole representation served under a ' +
          '200. Answering 416 here is what makes video players give up.',
      );
    } else {
      add('an INVALID range is ignored rather than refused', 'pass', `Range: bytes=9-4 -> ${invalid.status}`);
    }

    const past = await app.get(file.url, cfg.owner, { range: 'bytes=99999-' });
    if (past.status === 416 && /^bytes \*\/\d+$/.test(header(past, 'content-range'))) {
      add('an unsatisfiable range answers 416 with the size', 'pass', header(past, 'content-range'));
    } else if (past.status === 416) {
      add(
        'an unsatisfiable range answers 416 with the size',
        'fail',
        `416, Content-Range: ${header(past, 'content-range') || '(absent)'}`,
        'A 416 without `Content-Range: bytes * /<size>` is a dead end: the client asked because it did ' +
          'not know the size, and you did not tell it.',
      );
    } else {
      add('an unsatisfiable range answers 416 with the size', 'pass', `-> ${past.status}, not a 416`);
    }

    if (header(own, 'accept-ranges').toLowerCase() === 'bytes') {
      add('Accept-Ranges is advertised on the unranged response', 'pass', 'present on the 200');
    } else {
      add(
        'Accept-Ranges is advertised on the unranged response',
        'fail',
        `Accept-Ranges on the 200: ${header(own, 'accept-ranges') || '(absent)'}`,
        'A client reads this to decide whether it MAY seek. Sending it only on a 206 tells it at the ' +
          'one moment it cannot act on it.',
      );
    }
  } else {
    add(
      'byte ranges',
      'skipped',
      `Range: bytes=0-4 -> ${ranged.status}, so this route does not answer ranges`,
      undefined,
    );
  }

  // ---------------------------------------------------------------------------
  // 7. Revocation lands on the next request, not at some TTL.
  // ---------------------------------------------------------------------------
  if (app.share && app.unshare) {
    await app.share(file.id, cfg.stranger);
    const granted = await app.get(file.url, cfg.stranger);
    if (granted.status !== 200) {
      add(
        'revocation takes effect on the next request',
        'fail',
        `after share(), GET as ${cfg.stranger} -> ${granted.status}`,
        'The share did not take effect, so the revocation below could not be measured. Check that ' +
          'share() in your callbacks grants read on this file to this user.',
      );
    } else {
      await app.unshare(file.id, cfg.stranger);
      const revoked = await app.get(file.url, cfg.stranger);
      if (revoked.status === 200) {
        add(
          'revocation takes effect on the next request',
          'fail',
          `after unshare(), GET as ${cfg.stranger} -> 200, ${revoked.body.byteLength} byte(s)`,
          'Access survived revocation. If your read path redirects to a presigned URL, this is expected ' +
            'and is the trade you made: that URL stays valid for its whole TTL. If it does not, ' +
            'something is caching the decision.',
        );
      } else {
        add(
          'revocation takes effect on the next request',
          'pass',
          `after unshare(), GET as ${cfg.stranger} -> ${revoked.status}`,
        );
      }
    }
  } else {
    add('revocation takes effect on the next request', 'skipped', 'no share()/unshare() callbacks given');
  }

  // ---------------------------------------------------------------------------
  // 8. The response is not cacheable by anything between you and the client.
  // ---------------------------------------------------------------------------
  const cache = header(own, 'cache-control').toLowerCase();
  if (/no-store|private/.test(cache)) {
    add('an authorized response is not publicly cacheable', 'pass', `Cache-Control: ${cache}`);
  } else {
    add(
      'an authorized response is not publicly cacheable',
      'fail',
      `Cache-Control: ${cache || '(absent)'}`,
      'A shared cache or CDN may hand this response to the next caller, who is a different person. ' +
        'The authorization you did applies to one request, not to the copy an intermediary kept.',
    );
  }

  return summarise(checks);
}

function summarise(checks: AuditCheck[]): AuditReport {
  const passed = checks.filter((c) => c.outcome === 'pass').length;
  const failed = checks.filter((c) => c.outcome === 'fail').length;
  const skipped = checks.filter((c) => c.outcome === 'skipped').length;
  return { checks, passed, failed, skipped, ok: failed === 0 };
}

/** The report as something to print. Returns the text; prints nothing itself. */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    const mark = c.outcome === 'pass' ? 'PASS ' : c.outcome === 'fail' ? 'FAIL ' : 'SKIP ';
    lines.push(`${mark} ${c.name}`);
    lines.push(`       ${c.detail}`);
    if (c.why) lines.push(`       ${c.why}`);
  }
  lines.push('');
  lines.push(
    `==== ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped ====`,
  );
  if (report.failed === 0) {
    lines.push(
      'A pass means these properties held for the requests this made. It is not a security audit, ' +
        'and it cannot find a hole in a path it was not told about.',
    );
  }
  return lines.join('\n');
}
