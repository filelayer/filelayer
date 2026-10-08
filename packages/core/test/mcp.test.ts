/**
 * THE MCP SERVER IS A PRIVILEGE BOUNDARY, SO THESE ARE THE TESTS THAT MATTER.
 *
 * Not "does the tool return JSON". The questions worth holding down are the
 * ones where a wrong answer hands an agent authority it should not have:
 *
 *   1. No tool lets the caller choose who it is. If an `as` or `subject`
 *      argument ever appears, every permission check in the product becomes
 *      advisory. Asserted against what the server ADVERTISES over the
 *      protocol, so adding one fails here.
 *   2. The dangerous three are absent unless asked for: delete_file,
 *      file_audit, read_file.
 *   3. Authorization is the library's, not the server's: a subject with no
 *      standing gets not_found.
 *   4. Errors come back as a stable code with its fix, and NEVER carry
 *      `reason` -- the internal deny reason, which in a response body is an
 *      enumeration oracle.
 *   5. Every call is attributable in the audit trail as agent-originated.
 *      That is the property this server exists to add.
 *
 * These talk to the server through the SDK's in-memory transport rather than
 * calling stored handlers. An earlier version reached into
 * `server._registeredTools` and invoked the callback directly, which tests our
 * object graph rather than the server: it would pass just as happily if the SDK
 * ignored everything we passed it, and it broke on a private field rename.
 * Going through the protocol also exercises the schema validation, which is
 * half of what a tool definition is for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Filelayer } from '../src/index.ts';
import { filelayerMcpServer } from '../src/mcp.ts';

/**
 * These tests need the two OPTIONAL peer dependencies, so they skip themselves
 * when the peers are absent -- which is the case in a clean install, because
 * optional peers are not installed and that is the whole point of them.
 *
 * Skipped at the `it` level and not on the `describe`, deliberately. Skipping
 * the block would change `# tests` between a repository run and an install
 * run, and the published tally in docs/VERIFY-WHAT-YOU-INSTALLED.md would then
 * be right in one environment and wrong in the other. At this level the test
 * count is the same everywhere and only the skip count moves, which is the
 * same shape as the two suites that need two real database connections.
 *
 * This is what `check:suite-install` caught: a static import of an optional
 * peer in a shipped test file breaks "the tests ship, so every claim is
 * checkable from what you installed" for the whole suite, not just for this
 * file.
 */
const peers = await (async () => {
  try {
    return {
      Client: (await import('@modelcontextprotocol/sdk/client/index.js')).Client,
      InMemoryTransport: (await import('@modelcontextprotocol/sdk/inMemory.js'))
        .InMemoryTransport,
    };
  } catch {
    return null;
  }
})();

const SKIP = peers
  ? false
  : 'needs the optional peers: npm install @modelcontextprotocol/sdk zod';

const AGENT = 'test-agent/1.0';

async function world() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
  const { id } = await fl.files.put(new TextEncoder().encode('the contract'), {
    org: 'acme',
    owner: 'alice',
    name: 'contract.txt',
    contentType: 'text/plain',
  });
  return { fl, fileId: id };
}

type Server = Awaited<ReturnType<typeof filelayerMcpServer>>;

async function connect(serverOrPromise: Server | Promise<Server>) {
  const server = await serverOrPromise;
  const { Client, InMemoryTransport } = peers!;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

async function toolNames(server: Server | Promise<Server>) {
  const { tools } = await (await connect(server)).listTools();
  return tools.map((t) => t.name);
}

type Conn = Awaited<ReturnType<typeof connect>>;

/**
 * One transport per server. An `McpServer` refuses a second `connect()`, so a
 * helper that connected on every call worked for the first tool and then threw
 * "Already connected" -- which looked like a server defect and was a test
 * defect.
 */
async function call(client: Conn, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const everything = {
  as: 'alice',
  org: 'acme',
  agentLabel: AGENT,
  allowDestructive: true,
  exposeAuditTrail: true,
  returnFileBytes: true,
} as const;

describe('the MCP server', () => {
  it('advertises no way for a tool call to choose the subject', { skip: SKIP }, async () => {
    const { fl } = await world();
    const client = await connect(filelayerMcpServer(fl, everything));

    const { tools } = await client.listTools();
    assert.equal(tools.length, 10, `expected the default seven plus the three optional, got ${tools.map((t) => t.name).join(' ')}`);

    for (const tool of tools) {
      const keys = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const bad of ['as', 'actor', 'subject', 'principal', 'onBehalfOf']) {
        assert.ok(
          !keys.includes(bad),
          `tool ${tool.name} advertises "${bad}", which lets the agent choose who it ` +
            'is and makes every authorization check in this product advisory',
        );
      }
      // `user` is legitimate on the sharing tools: it names the RECIPIENT, not
      // the caller. Allowed only there.
      if (keys.includes('user')) {
        assert.ok(
          ['share_with_user', 'unshare_user'].includes(tool.name),
          `tool ${tool.name} takes "user", and only the sharing tools have a recipient`,
        );
      }
    }
  });

  it('registers exactly the default seven, by name', { skip: SKIP }, async () => {
    const { fl } = await world();
    const quiet = await toolNames(
      filelayerMcpServer(fl, { as: 'alice', org: 'acme', agentLabel: AGENT }),
    );

    // By name and by count, because the published pages state the number. The
    // first version of this file asserted `>= 8` with all three options on,
    // which is ten, so it never looked at the default set -- and the README,
    // llms.txt and the changelog all shipped saying "eight tools by default"
    // over a list of seven. A number in prose that nothing asserts is a number
    // nobody checked.
    assert.deepEqual(quiet.sort(), [
      'create_share_link',
      'file_info',
      'list_files',
      'list_shares',
      'revoke_share',
      'share_with_user',
      'unshare_user',
    ]);
  });

  it('registers the dangerous three only when asked', { skip: SKIP }, async () => {
    const { fl } = await world();

    const quiet = await toolNames(
      filelayerMcpServer(fl, { as: 'alice', org: 'acme', agentLabel: AGENT }),
    );
    for (const name of ['delete_file', 'file_audit', 'read_file']) {
      assert.ok(!quiet.includes(name), `${name} is registered by default`);
    }
    assert.ok(quiet.includes('list_files'), `the default server is useless: ${quiet.join(', ')}`);

    const loud = await toolNames(filelayerMcpServer(fl, everything));
    for (const name of ['delete_file', 'file_audit', 'read_file']) {
      assert.ok(loud.includes(name), `${name} stayed absent after being asked for`);
    }
  });

  it('refuses a subject with no standing, through the library rather than itself', { skip: SKIP }, async () => {
    const { fl, fileId } = await world();
    const stranger = await connect(
      filelayerMcpServer(fl, { as: 'bob', org: 'acme', agentLabel: AGENT }),
    );

    const r = await call(stranger, 'file_info', { fileId });
    assert.equal(r.isError, true, `bob was not refused: ${r.content[0]!.text}`);
    const body = payload(r);
    assert.equal(body.error, 'not_found', `expected not_found, got ${JSON.stringify(body)}`);
    assert.equal(
      body.status,
      404,
      'a 403 would confirm the file exists to somebody who may not know that',
    );
    assert.ok(body.fix, 'the error carried no fix, so an agent cannot act on it');
  });

  it('never returns the internal deny reason', { skip: SKIP }, async () => {
    const { fl, fileId } = await world();
    const stranger = await connect(
      filelayerMcpServer(fl, { as: 'bob', org: 'acme', agentLabel: AGENT }),
    );

    const cases: [string, Record<string, unknown>][] = [
      ['file_info', { fileId }],
      ['list_shares', { fileId }],
      ['share_with_user', { fileId, user: 'carol', expiresInSeconds: 3600 }],
    ];
    for (const [name, args] of cases) {
      const r = await call(stranger, name, args);
      const text = r.content[0]!.text;
      assert.ok(!('reason' in payload(r)), `${name} serialized a reason: ${text}`);
      for (const leak of ['no_membership', 'grant_revoked', 'bad_link_secret']) {
        assert.ok(!text.includes(leak), `${name} leaked the deny reason "${leak}"`);
      }
    }
  });

  it('attributes every call to the agent in the audit trail', { skip: SKIP }, async () => {
    const { fl, fileId } = await world();
    const server = await connect(
      filelayerMcpServer(fl, { as: 'alice', org: 'acme', agentLabel: AGENT }),
    );

    await call(server, 'file_info', { fileId });
    await call(server, 'list_files', {});
    const shared = await call(server, 'share_with_user', {
      fileId,
      user: 'bob',
      expiresInSeconds: 3600,
    });
    assert.notEqual(shared.isError, true, `sharing failed: ${shared.content[0]!.text}`);

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const byAgent = log.filter((e) => e.userAgent === AGENT);
    assert.ok(
      byAgent.length >= 2,
      `expected several agent-attributed events, got ${byAgent.length} of ${log.length}`,
    );
    // The control. The setup ran without the server, so the trail must still
    // hold events that are NOT the agent's -- otherwise this test would pass
    // just as well if everything were tagged and the tag distinguished nothing.
    assert.ok(
      log.some((e) => e.userAgent !== AGENT),
      'every event is attributed to the agent, so the tag separates nothing',
    );
  });

  it('refuses an empty agent label rather than writing unattributable events', { skip: SKIP }, async () => {
    const { fl } = await world();
    await assert.rejects(
      () => filelayerMcpServer(fl, { as: 'alice', org: 'acme', agentLabel: '  ' }),
      /agentLabel/,
      'an empty agent label was accepted, so events would be written unattributable',
    );
  });

  it('declares which tools mutate, so a client can gate them', { skip: SKIP }, async () => {
    const { fl } = await world();
    const client = await connect(filelayerMcpServer(fl, everything));
    const { tools } = await client.listTools();
    const by = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));

    assert.equal(by.get('list_files')?.readOnlyHint, true);
    assert.equal(by.get('share_with_user')?.readOnlyHint, false);
    assert.equal(
      by.get('delete_file')?.destructiveHint,
      true,
      'delete_file does not declare itself destructive, so a client cannot gate it',
    );
  });

  it('refuses a share with no expiry, because the schema has no way to ask for one', { skip: SKIP }, async () => {
    const { fl, fileId } = await world();
    const server = await connect(
      filelayerMcpServer(fl, { as: 'alice', org: 'acme', agentLabel: AGENT }),
    );

    // `expiresInSeconds` is required, so the protocol rejects the call before it
    // reaches us. A permanent grant is a decision a person makes.
    const r = await call(server, 'share_with_user', { fileId, user: 'bob' });
    assert.equal(r.isError, true, 'a share with no expiry was accepted');
  });
});
