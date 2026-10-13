# Letting an agent operate it

Two ways, and they differ only in who constructs the instance: build the server
over one you already have, or run the shipped binary and let it build the
instance from the environment.

`@filelayer/core/mcp` builds an MCP server over an instance, so an agent can
answer "which contracts can Alice see", "share this one with the external
accountant for two weeks", "take that back" — through the same authorization
code path as your HTTP routes, with no second set of rules to keep in agreement.
You construct it and you run it; there is nothing hosted and nothing to sign up
for.

<!-- doccheck: skip reason="it connects a server to stdio and never returns, and it imports the MCP SDK, which is an optional peer this checker does not install" -->
```ts
import { filelayerMcpServer } from '@filelayer/core/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = await filelayerMcpServer(fl, {
  as: 'user_partner_alice',          // fixed here, not a tool argument
  org: 'org_acme',
  agentLabel: 'acme-assistant/1.0',  // how the audit trail names the agent
});
await server.connect(new StdioServerTransport());
```

**The subject is fixed at construction.** It is not a tool parameter and no
tool changes it, because the obvious design — a `user` argument on every call —
lets the agent choose who it is, which makes every permission check advisory. An
MCP server that can act as anyone is an admin backdoor with a schema. One server
speaks for one subject in one organisation; serving several people means
constructing several servers, and that cost is the property.

Seven tools by default: list files, describe one, list its grants, share with a
person, create a link, revoke one grant, remove a person entirely. Expiry is
required on both sharing tools, because a permanent grant is a decision a person
should make. Each tool declares `readOnlyHint` and `destructiveHint` so a client
can gate the ones that write. Failures come back as the stable error `code` with
the `meaning` and `fix` from the catalogue, and never with `reason`.

Three things are off by default, each for its own reason: `allowDestructive`
(deleting is not recoverable), `returnFileBytes` (a document returned by a tool
is a document copied into a model's context), and `exposeAuditTrail` — because
the trail is an organisation's whole history, and a tool that returns it copies
every file name, actor and denial into that context too. Reading the trail is
itself audited, on the same chain as every other decision.

This module is the only part of the package with dependencies, and they are
optional peers, so the install above stays at zero:

```bash
npm install @modelcontextprotocol/sdk zod
```

`zod` is not a preference: the SDK accepts Zod schemas for a tool's inputs and
nothing else. Calling the factory without either one throws and names what is
missing and the command.

Every call made through these tools records `agentLabel` as the audit event's
user agent, which is what lets the chain separate "the partner opened this" from
"the partner's assistant opened this".

If you want a server a client can simply start, there is a second binary that
builds the instance from the environment:

```json
{
  "mcpServers": {
    "filelayer": {
      "command": "npx",
      "args": ["-y", "-p", "@filelayer/core", "filelayer-mcp"],
      "env": {
        "DATABASE_URL": "postgres://...",
        "FILELAYER_AS": "user_alice",
        "FILELAYER_ORG": "org_acme",
        "FILELAYER_DATA_DIR": "/srv/filelayer-data"
      }
    }
  }
}
```

`FILELAYER_AS` comes from whoever configures the client, never from a
conversation — one process speaks for one subject, and many users means a server
per user. With neither `FILELAYER_DATA_DIR` nor `S3_ENDPOINT` set it refuses to
start rather than falling back to memory, which would work in a demo and lose
the first real file. The three tools above stay off unless the matching
`FILELAYER_MCP_*` variable is exactly `true`.

[`examples/mcp/`](https://github.com/filelayer/filelayer/tree/main/examples/mcp)
is a server you can launch and a script that drives it the way a client does:
it spawns the server as a subprocess and exchanges protocol frames over its
real stdin and stdout, in 27 checks that CI runs against a freshly packed
tarball on every commit.

---

Back to the [README](https://github.com/filelayer/filelayer/blob/main/README.md) · [Quickstart](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) · [what it does not do](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
