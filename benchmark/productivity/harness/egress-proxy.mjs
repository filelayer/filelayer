#!/usr/bin/env node
/**
 * THE ONLY WAY OUT OF A RUN'S NETWORK.
 *
 * An HTTP proxy that tunnels HTTPS (CONNECT) to the hosts on an allowlist and
 * refuses everything else. The agent's container sits on an internal Docker
 * network with no route out; this proxy is the one container on both that
 * network and the outside one. Every attempt, allowed or refused, is a line
 * in the log, so the report can say what each run reached for (how much of it
 * was documentation, and of whom).
 *
 *   node egress-proxy.mjs --port 3128 --allow allowlist.txt --log egress.jsonl
 *
 * The allowlist is one host per line; `*.example.com` matches subdomains of
 * example.com and not example.com itself. Blank lines and lines starting with
 * # are ignored. Plain HTTP is refused: everything the run needs speaks HTTPS.
 *
 * --upstream http://host:port tunnels each allowed connection through another
 * proxy instead of connecting directly, for machines whose own way out is a
 * proxy. --listen sets the address to bind (default 0.0.0.0).
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const port = Number(arg('--port', '3128'));
const logFile = arg('--log', null);
const upstream = arg('--upstream', null) ? new URL(arg('--upstream')) : null;
const listenOn = arg('--listen', '0.0.0.0');
const rules = readFileSync(arg('--allow'), 'utf8')
  .split('\n')
  .map((l) => l.trim().toLowerCase())
  .filter((l) => l && !l.startsWith('#'));

export function allowed(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return rules.some((r) => (r.startsWith('*.') ? h.endsWith(r.slice(1)) : h === r));
}

function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  if (logFile) appendFileSync(logFile, line + '\n');
}

const server = createServer((req, res) => {
  log({ method: req.method, host: req.headers.host ?? null, allowed: false, why: 'plain_http' });
  res.writeHead(403, { 'content-type': 'text/plain' }).end('plain HTTP is not allowed\n');
});

server.on('connect', (req, client, head) => {
  const [host, portStr] = String(req.url).split(':');
  const p = Number(portStr || 443);
  const ok = p === 443 && allowed(host);
  log({ method: 'CONNECT', host, port: p, allowed: ok });
  if (!ok) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const out = upstream ? connect(Number(upstream.port), upstream.hostname) : connect(p, host);
  const ready = () => {
    // Successes are logged too, so a passing error can be told from a host
    // that stayed down (analyze.mjs).
    log({ method: 'CONNECT', host, port: p, allowed: true, connected: true });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) out.write(head);
    out.pipe(client);
    client.pipe(out);
  };
  if (upstream) {
    out.once('connect', () => out.write(`CONNECT ${host}:${p} HTTP/1.1\r\nHost: ${host}:${p}\r\n\r\n`));
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      out.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) {
        log({ method: 'CONNECT', host, port: p, allowed: true, error: `upstream: ${buf.split('\r\n')[0]}` });
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        out.destroy();
        return;
      }
      const rest = Buffer.from(buf.slice(end + 4), 'latin1');
      ready();
      if (rest.length) client.write(rest);
    };
    out.on('data', onData);
  } else {
    out.once('connect', ready);
  }
  const close = () => {
    out.destroy();
    client.destroy();
  };
  out.on('error', (e) => {
    log({ method: 'CONNECT', host, port: p, allowed: true, error: e.code ?? e.message });
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  client.on('error', close);
});

server.listen(port, listenOn, () => log({ started: true, port, rules: rules.length }));
