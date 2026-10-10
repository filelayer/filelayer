#!/usr/bin/env node
/**
 * A launchable MCP server over YOUR Filelayer deployment.
 *
 *     filelayer-mcp
 *
 * Configured entirely from the environment, so an MCP client can start it with
 * a command and an `env` block and nothing else:
 *
 *     {
 *       "mcpServers": {
 *         "filelayer": {
 *           "command": "npx",
 *           "args": ["-y", "@filelayer/core", "filelayer-mcp"],
 *           "env": {
 *             "DATABASE_URL": "postgres://...",
 *             "FILELAYER_AS": "user_alice",
 *             "FILELAYER_ORG": "org_acme",
 *             "FILELAYER_DATA_DIR": "/srv/filelayer-data"
 *           }
 *         }
 *       }
 *     }
 *
 * =============================================================================
 * WHY THIS EXISTS SEPARATELY FROM `filelayerMcpServer()`
 * =============================================================================
 *
 * The factory in `@filelayer/core/mcp` is for an application that already has a
 * Filelayer instance and a session: it hands you the subject and you build the
 * server. That is the right shape for a product, and it is unusable as a
 * registry entry, because there is nothing to point a client at.
 *
 * This file is the other half: it builds the instance from the environment so
 * the server can be started by something that knows nothing about your code. It
 * is deliberately a thin wrapper and contains no authorization logic of its
 * own.
 *
 * =============================================================================
 * FILELAYER_AS IS THE WHOLE SAFETY ARGUMENT, AND IT COMES FROM THE OPERATOR
 * =============================================================================
 *
 * One server process speaks for exactly one subject, fixed before any tool is
 * registered. No tool changes it and no tool takes it as an argument, because
 * an agent that chooses who it is makes every permission check in this product
 * advisory.
 *
 * So `FILELAYER_AS` must be written by whoever configures the client -- a
 * person, or your own provisioning -- and never derived from a conversation. If
 * your product has many users, you start a server per user. That is the cost of
 * the property and it is not hidden.
 *
 * =============================================================================
 * NOTHING MAY BE WRITTEN TO STDOUT
 * =============================================================================
 *
 * stdout carries protocol frames. A stray `console.log` corrupts the stream and
 * the client reports a parse error, which reads like a broken server and is a
 * broken log line. Everything diagnostic here goes to stderr.
 */

import { Filelayer } from './filelayer.ts';
import { filelayerMcpServer } from './mcp.ts';
import { FsStorage, S3Storage, type StorageAdapter } from './storage.ts';

const say = (s: string) => process.stderr.write(`${s}\n`);

function fail(lines: string[]): never {
  say(`\nfilelayer-mcp: ${lines.join('\n  ')}\n`);
  process.exit(2);
}

function required(name: string, advice: string): string {
  const v = process.env[name];
  if (!v) fail([`${name} is not set.`, '', advice]);
  return v;
}

// -----------------------------------------------------------------------------
// Storage first, before the database is touched, so a bad storage configuration
// exits without having connected or applied anything. The starter example
// learned this the hard way and the comment there explains why.
// -----------------------------------------------------------------------------
function storageFromEnv(): StorageAdapter {
  const endpoint = process.env['S3_ENDPOINT'];
  if (endpoint) {
    const advice =
      'You set S3_ENDPOINT, so the bucket variables are required. Unset it to use\n' +
      '  a local directory instead, which needs none of them.';
    say(`storage: S3Storage at ${endpoint}`);
    return new S3Storage({
      endpoint,
      bucket: required('S3_BUCKET', advice),
      region: process.env['S3_REGION'] ?? 'auto',
      accessKeyId: required('S3_ACCESS_KEY_ID', advice),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY', advice),
    });
  }
  const dir = process.env['FILELAYER_DATA_DIR'];
  if (dir) {
    say(`storage: FsStorage at ${dir}`);
    return new FsStorage(dir);
  }
  // NOT MemoryStorage. A server that silently accepted uploads into a Map and
  // lost them when the client restarted would be the worst possible default:
  // it works in the demo and loses the first real file.
  return fail([
    'no storage is configured.',
    '',
    'Set FILELAYER_DATA_DIR to a directory, which needs no bucket and no IAM user,',
    '  or S3_ENDPOINT plus S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    '',
    'There is deliberately no in-memory default: it would work in a demo and lose',
    '  the first real file when the client restarted this process.',
  ]);
}

const storage = storageFromEnv();

const DATABASE_URL = required(
  'DATABASE_URL',
  'Any Postgres you own:\n' +
    '    DATABASE_URL=postgres://user:pass@localhost:5432/mydb\n\n' +
    '  Apply the schema once before starting this:\n' +
    '    psql "$DATABASE_URL" -f node_modules/@filelayer/core/schema.sql',
);

const AS = required(
  'FILELAYER_AS',
  'The subject this server speaks for, in your own id space.\n\n' +
    '  It is fixed for the life of the process and no tool can change it, which is\n' +
    '  the only reason this is safe to expose to an agent. Write it yourself or have\n' +
    '  your provisioning write it; never derive it from a conversation. One server\n' +
    '  per user if you have many.',
);

const ORG = required('FILELAYER_ORG', 'The organisation this server is scoped to, in your own id space.');

const flag = (name: string) => process.env[name] === 'true';

let pg: typeof import('pg');
try {
  pg = await import('pg');
} catch {
  fail([
    'the pg driver is not installed.',
    '',
    '@filelayer/core has no runtime dependencies; this server is one of the parts',
    '  that needs a PostgreSQL driver.',
    '',
    '    npm install pg',
  ]);
}

const PoolCtor =
  (pg as unknown as { Pool?: typeof import('pg').Pool }).Pool ??
  (pg as unknown as { default: { Pool: typeof import('pg').Pool } }).default.Pool;
const pool = new PoolCtor({ connectionString: DATABASE_URL });

try {
  await pool.query('select 1');
} catch (e) {
  // The driver's message, not the connection string: it carries the password
  // and this goes into a client's log.
  fail([
    `the database could not be reached: ${String((e as Error).message).slice(0, 160)}`,
    '',
    'Check the host, the port, and whether this machine is allowed to connect.',
  ]);
}

const fl = new Filelayer(pool, storage, {
  ...(process.env['FILELAYER_BASE_URL'] ? { baseUrl: process.env['FILELAYER_BASE_URL'] } : {}),
});

const server = await filelayerMcpServer(fl, {
  as: AS,
  org: ORG,
  agentLabel: process.env['FILELAYER_MCP_AGENT_LABEL'] ?? 'filelayer-mcp',

  // All three off unless the operator says otherwise, and each for its own
  // reason -- see the comments in src/mcp.ts. `true` and nothing else, so a
  // typo is off rather than on.
  allowDestructive: flag('FILELAYER_MCP_ALLOW_DESTRUCTIVE'),
  exposeAuditTrail: flag('FILELAYER_MCP_EXPOSE_AUDIT'),
  returnFileBytes: flag('FILELAYER_MCP_RETURN_BYTES'),
});

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

say(`filelayer-mcp: acting as ${AS} in ${ORG}`);
await server.connect(new StdioServerTransport());
