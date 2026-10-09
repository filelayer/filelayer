# An MCP server over Filelayer

A server an MCP client can launch, over an instance with two files in it, with a
script that drives it the way a client does.

```bash
npm install @filelayer/core @modelcontextprotocol/sdk zod
npm install --save-dev "@electric-sql/pglite@^0.3.11"

node --experimental-strip-types server.ts   # speaks the protocol on stdio
node verify.mjs                             # spawns that and drives it: 27 checks
```

`verify.mjs` launches `server.ts` as a subprocess and exchanges protocol frames
with its stdin and stdout, because that is what a client does. The package's own
tests use an in-memory transport, which proves the tools behave and does not
prove this: a server that writes one stray line to stdout passes every in-memory
test and is unusable from a client.

## Adding it to a client

Most clients take a command and arguments:

```json
{
  "mcpServers": {
    "filelayer": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/server.ts"],
      "env": { "FILELAYER_AS": "user_alice", "FILELAYER_ORG": "org_acme" }
    }
  }
}
```

## What is real here and what is a stand-in

Real: the server, the seven tools, the authorization path, the audit
attribution. Every call goes through the same code an HTTP route would.

A stand-in: the instance. `Filelayer.quickstart()` runs PostgreSQL compiled to
WebAssembly in-process with the bytes in memory, and **everything is lost when
the process exits** — which for an MCP server means every time the client
restarts it. It is here so this runs with no setup. A real one takes your own
`pg.Pool` and your own bucket; [`examples/starter/`](../starter/README.md) is
that.

A stand-in: the subject. `FILELAYER_AS` and `FILELAYER_ORG` come from the
environment with demo defaults.

## The part to read before deploying anything like this

**The subject is fixed when the server is constructed.** No tool changes it, and
adding a `user` argument to one would make every permission check in the product
advisory, because the agent would be choosing who it is.

So one server process speaks for one person. If your product has many users you
launch a server per user, and the id comes from your own session — never from
the model, never from a tool argument, never from a prompt. An MCP server that
can act as anyone is an admin backdoor with a schema.

`verify.mjs` asserts this against what the server advertises over the protocol,
so a tool that grew an `as` or `subject` argument would fail it.

## Three tools this example does not turn on

`delete_file` and `read_file` are off, as they default. Deleting is not
recoverable, and a document returned by a tool is a document copied into a
model's context — `file_info` plus a share link is usually what the agent
actually needed.

`file_audit` IS on here, so the example can show the attribution, which is the
point of the whole thing. Think before turning it on in production: reading the
audit trail is the one act Filelayer does not itself record, so an agent can
read an organisation's entire history and leave nothing behind
([`LIMITATIONS.md`](../../LIMITATIONS.md) entry 16).

## What the checks establish

Beyond the tools working, three things worth knowing:

**A share with no expiry is refused by the schema**, before it reaches the
library. Both sharing tools require `expiresInSeconds`, because a permanent
grant is a decision a person should make rather than one an agent arrives at.

**A missing file answers `not_found` with a `fix`, and never a `reason`.** The
404 does not confirm existence to someone who may not be entitled to know, and
the internal deny reason stays out of the response because in a body it is an
enumeration oracle. The `fix` comes from the generated error catalogue, so an
agent is told what to do rather than left with a status number.

**The agent's calls are attributed and the seeding is not.** Every tool call
records `agentLabel` as the event's user agent, which is what lets the chain
separate "the partner opened this" from "the partner's assistant opened this".
The checks assert both halves: that the agent's reads carry the label and that
the seeded writes do not, because a label on everything would separate nothing.

One thing the checks establish by absence: a probe at a file id that does not
exist is recorded against the **system** chain rather than this tenant's, since
charging an enumeration attempt to a tenant would leak whether the file is
theirs. That chain is cross-tenant, so a server scoped to one subject does not
expose it, and `file_audit` therefore cannot answer "did anyone try ids they
should not have".
