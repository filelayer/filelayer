/**
 * An MCP server over Filelayer, launchable by any MCP client.
 *
 *   node --experimental-strip-types server.ts
 *
 * It speaks the protocol on stdin/stdout, which is how a client starts one. Add
 * it to a client's config and the tools appear; there is nothing hosted and no
 * account.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN
 * ---------------------------------------------------------------------------
 *
 * REAL: the server, the tools, the authorization path, the audit attribution.
 * Every tool call below goes through the same code as an HTTP route would.
 *
 * STAND-IN: the instance. `Filelayer.quickstart()` runs PostgreSQL compiled to
 * WebAssembly in this process with the bytes in memory, and **everything is
 * lost when the process exits** -- which for an MCP server means every time the
 * client restarts it. It is here so this file runs with no setup. A real one
 * takes your own `pg.Pool` and your own bucket; see `examples/starter/`.
 *
 * STAND-IN: the subject. `AS` and `ORG` are read from the environment with
 * demo defaults. In a real deployment they come from whoever the client is
 * acting for, and that is the whole design -- see below.
 *
 * ---------------------------------------------------------------------------
 * THE THING TO UNDERSTAND BEFORE DEPLOYING THIS
 * ---------------------------------------------------------------------------
 *
 * The subject is fixed when the server is constructed. There is no tool that
 * changes it, and adding a `user` argument to one would make every permission
 * check in the product advisory: the agent would choose who it is.
 *
 * So one server process speaks for one person. If your product has many users,
 * you launch a server per user with that user's id, and the id comes from your
 * own session -- never from the model, never from a tool argument, and never
 * from a prompt. An MCP server that can act as anyone is an admin backdoor with
 * a schema.
 */

import { Filelayer } from '@filelayer/core';
import { filelayerMcpServer } from '@filelayer/core/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const AS = process.env.FILELAYER_AS ?? 'user_alice';
const ORG = process.env.FILELAYER_ORG ?? 'org_acme';

// A throwaway instance with something in it, so the tools have something to
// answer. Nothing here is part of the MCP story; it is the seed.
const fl = await Filelayer.quickstart();
await fl.orgs.create(ORG, { owner: AS });
await fl.orgs.setRole(ORG, 'user_bob', 'member', { as: AS });

await fl.files.put(new TextEncoder().encode('Q3 figures, draft.\n'), {
  org: ORG,
  owner: AS,
  name: 'q3-draft.txt',
  contentType: 'text/plain',
});
await fl.files.put(new TextEncoder().encode('Signed, 4 October.\n'), {
  org: ORG,
  owner: AS,
  name: 'engagement-letter.txt',
  contentType: 'text/plain',
});

const server = await filelayerMcpServer(fl, {
  as: AS,
  org: ORG,
  agentLabel: 'filelayer-example-mcp/1.0',

  // On here so the example can show the audit trail, which is the point of the
  // whole thing. Think before turning it on in a real deployment: reading the
  // trail is not itself recorded, so an agent can read an organisation's entire
  // history and leave nothing behind. See LIMITATIONS.md entry 16.
  exposeAuditTrail: true,

  // Left off, as they default. `allowDestructive` because deleting is not
  // recoverable, and `returnFileBytes` because a document returned by a tool is
  // a document copied into a model's context.
});

// Nothing may be written to stdout but protocol frames. A stray console.log
// here corrupts the stream and the client reports a parse error, which looks
// like a bug in the server and is a bug in the logging.
process.stderr.write(`filelayer mcp: acting as ${AS} in ${ORG}\n`);

await server.connect(new StdioServerTransport());
