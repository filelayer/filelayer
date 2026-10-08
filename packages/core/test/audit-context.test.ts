/**
 * "A PERSON OPENED THIS" AND "A PERSON'S AGENT OPENED THIS" ARE DIFFERENT FACTS.
 *
 * THE DEFECT. `Principal` has carried `ip` and `userAgent` since the beginning
 * and the route layer passes them, but the `files.*` / `shares.*` / `orgs.*`
 * tier did not expose them. Every call made through that tier -- which is the
 * tier the README, the quickstart, the guides and the Agent Skill all teach --
 * wrote an audit event with `user_agent` null. Survivable while every caller
 * was a web request arriving through a route. Not survivable with an MCP
 * server: an agent acting for a partner produces a read that is
 * indistinguishable, in the chain, from the partner reading it herself, and a
 * compliance auditor has no way to separate them because the library gave the
 * caller nowhere to say which it was.
 *
 * WHAT THIS SUITE HOLDS DOWN.
 *
 *   1. `userAgent` and `ip` passed to `files.get` land on the event.
 *   2. Omitting them is unchanged: null, not the string "undefined".
 *   3. `shares.create` and `shares.list` carry them too, because a grant
 *      created by an agent is the event most worth attributing.
 *   4. Reading the trail is NOT itself recorded, with or without context. That
 *      is a gap, not a design decision, and it is the reason the MCP server
 *      does not expose the trail by default. Pinned here so that closing the
 *      gap breaks this test and forces the published limitation to be removed
 *      in the same commit.
 *   5. They are NOT an authorization input. A denied read records the context
 *      and stays denied, and a context that claims to be someone else changes
 *      no decision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Filelayer } from '../src/index.ts';

const AGENT = 'filelayer-mcp/1.0 (agent; acting-for=alice)';
const IP = '203.0.113.7';

async function scenario(fl: Filelayer) {
  await fl.orgs.create('acme', { owner: 'alice' });
  const { id } = await fl.files.put(new TextEncoder().encode('quarterly'), {
    org: 'acme',
    owner: 'alice',
    name: 'q3.pdf',
  });
  return id;
}

describe('audit context on the facade', () => {
  it('records the user agent and ip a caller asserts', async () => {
    const fl = await Filelayer.quickstart();
    const id = await scenario(fl);

    await fl.files.get(id, { as: 'alice', userAgent: AGENT, ip: IP });

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const read = log.find((e) => e.userAgent === AGENT);
    assert.ok(
      read,
      `no event carries the asserted agent. user agents seen: ${JSON.stringify(
        log.map((e) => e.userAgent),
      )}`,
    );
    assert.equal(read.ip, IP);
  });

  it('leaves them null when the caller says nothing', async () => {
    const fl = await Filelayer.quickstart();
    const id = await scenario(fl);

    await fl.files.get(id, { as: 'alice' });

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    for (const e of log) {
      assert.notEqual(e.userAgent, 'undefined', 'the string "undefined" reached the column');
      assert.ok(
        e.userAgent === null || e.userAgent === undefined,
        `expected no user agent, got ${JSON.stringify(e.userAgent)}`,
      );
    }
  });

  it('attributes a grant created through an agent', async () => {
    const fl = await Filelayer.quickstart();
    const id = await scenario(fl);

    await fl.shares.create(id, {
      as: 'alice',
      withUser: 'marco',
      expiresIn: 3600,
      userAgent: AGENT,
    });
    await fl.shares.list(id, { as: 'alice', userAgent: AGENT });

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const attributed = log.filter((e) => e.userAgent === AGENT);
    assert.ok(
      attributed.length >= 2,
      `expected the grant creation and the listing to be attributed, got ${attributed.length}`,
    );
  });

  it('does not record the act of reading the trail, with or without context', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);

    const before = (await fl.orgs.audit('acme', { as: 'alice' })).length;
    await fl.orgs.audit('acme', { as: 'alice', userAgent: AGENT });
    const after = await fl.orgs.audit('acme', { as: 'alice' });

    // This asserts the CURRENT behaviour, and the behaviour is a gap rather
    // than a decision: reading the audit trail is not itself an audited act,
    // so an agent can read an entire organisation's history and leave nothing
    // behind. The context passed above is accepted and then has nothing to
    // attach to. LIMITATIONS.md carries this; the test exists so that if
    // somebody makes reading auditable, this fails and tells them to go and
    // delete the limitation rather than leaving a stale one published.
    assert.equal(
      after.length,
      before,
      'reading the trail now writes an event: make `orgs.audit` reads auditable on ' +
        'purpose, update LIMITATIONS.md, and turn this assertion around',
    );
    assert.ok(
      !after.some((e) => e.userAgent === AGENT),
      'a read of the trail was attributed, which contradicts the limitation above',
    );
  });

  it('is not an authorization input', async () => {
    const fl = await Filelayer.quickstart();
    const id = await scenario(fl);

    // A stranger, asserting a user agent that names the owner. The claim is
    // recorded and changes nothing: if audit context could influence a
    // decision it would be a credential, and a credential a caller writes for
    // itself is not one.
    await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
    await assert.rejects(
      () => fl.files.get(id, { as: 'bob', userAgent: 'alice' }),
      (e: { code?: string }) => e.code === 'not_found' || e.code === 'forbidden',
      'a stranger asserting the owner as its user agent was not refused',
    );

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const denied = log.find((e) => e.decision === 'deny' && e.userAgent === 'alice');
    assert.ok(denied, 'the refused call recorded no context, so the claim is unreviewable');
  });
});
