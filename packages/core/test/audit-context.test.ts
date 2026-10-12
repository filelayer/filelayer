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

  it('records the act of reading the trail, and attributes it', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);

    // THIS ASSERTION WAS THE OTHER WAY ROUND UNTIL 0.27.0, and the turn is the
    // point. It used to pin the gap -- reading the trail wrote nothing -- so
    // that closing the gap would break this test and force the published
    // limitation to be deleted in the same commit. That is what happened, and
    // LIMITATIONS.md entry 16 is gone.
    const first = await fl.orgs.audit('acme', { as: 'alice' });

    // A read sees ITSELF: the event is written during authorization, before the
    // query runs, so the first read already contains its own `audit.read`.
    // Asserted rather than assumed, because the alternative -- a read that is
    // recorded but invisible until the next one -- would be a chain that lies
    // about its own latest state.
    assert.ok(
      first.some((e) => e.action === 'audit.read'),
      'a read did not contain its own audit.read event, so reads are recorded ' +
        'after the query rather than during authorization. That ordering loses an ' +
        'authorized read that then fails.',
    );

    const second = await fl.orgs.audit('acme', { as: 'alice', userAgent: AGENT, ip: IP });
    assert.equal(
      second.length,
      first.length + 1,
      'one read must write exactly one event. More than one is a bug; fewer is the ' +
        'coalescing that `filelayer.ts` refuses, which would let a reader who looked ' +
        'fifty times leave a record saying they looked once.',
    );

    const third = await fl.orgs.audit('acme', { as: 'alice', decision: 'allow', limit: 50 });
    const reads = third.filter((e) => e.action === 'audit.read');

    // The context the caller passes now has something to attach to, which is
    // the whole of the MCP case: "the partner read her own history" and "the
    // partner's agent read it for her" are different facts and the chain can
    // now tell them apart.
    const byAgent = reads.filter((e) => e.userAgent === AGENT);
    assert.equal(byAgent.length, 1, 'exactly the one read made with an agent should carry it');
    assert.equal(byAgent[0]!.ip, IP);
    assert.equal(byAgent[0]!.decision, 'allow');

    // The filter asked for is recorded; the rows returned are not. The shape of
    // the question separates "read everything for actor X" from "read one file",
    // and that difference is what an investigator needs.
    assert.deepEqual(
      byAgent[0]!.context.filter,
      {},
      'the second read passed no filter, so the recorded filter should be empty rather ' +
        'than a normalised one with defaults invented into it',
    );
    // The third read passed a filter, and since a read sees itself it must
    // contain its own event carrying that filter. The first draft of this test
    // asserted the opposite here and contradicted its own earlier assertion
    // eight lines up; the suite caught it.
    const withFilter = reads.find(
      (e) => (e.context.filter as { limit?: number } | undefined)?.limit === 50,
    );
    assert.ok(withFilter, 'the filter the third read asked for was not recorded');
    assert.equal(
      (withFilter.context.filter as { decision?: string }).decision,
      'allow',
      'the recorded filter should carry every field the caller passed, not just some',
    );

    // The facade accepts only `decision` and `limit` of AuditFilter's five
    // fields, which is why this asserts on `decision` rather than on `action`.
    // The first draft of this test passed `action` and typecheck refused it --
    // correctly, and it is how that gap was noticed. `fileId`, `actorId` and
    // `action` are exactly the filters an investigator reaches for, and
    // `action: 'audit.read'` is the one this very feature creates demand for.
    // Not bolted on here: resolving an external user id needs a LOOKUP-ONLY
    // resolver, because `ids.actor()` upserts and filtering by an unknown name
    // would create an actor row as a side effect of a read.
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
