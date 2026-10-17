# How do I revoke a share after the recipient has shared it onwards?

Most writing about file sharing stops at the first hop. You share a file with
Bob, you revoke Bob, Bob is out. That design is correct and it answers a
question almost nobody has, because the moment a share feature is useful people
start forwarding access — to a colleague, to a contractor, to a tool.

This guide is about the second hop and everything after it. It is written to be
useful whether or not you use Filelayer: the schema, the function and the
trigger below are yours to copy, and the script beside this page reproduces
every number against a real PostgreSQL in about thirty seconds.

---

## The short answer

**Whether you can revoke onward access is decided when you store the share, not
when you revoke it.** If a re-share writes an independent row, no revoke
endpoint you write later can undo it — the database has forgotten that the
second grant ever depended on the first.

So the whole feature is one column and one predicate:

- a `parent_grant_id` on the grant row, pointing at the authority it came from
- liveness evaluated over the **whole ancestor chain**, not over the row

Everything else in this guide is the five ways that pairing is got wrong.

---

## What goes wrong without it

Take the ordinary design — a `share_link` table, each row standing on its own:

```sql
SELECT * FROM share_link
 WHERE secret_hash = $1
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now());
```

Alice shares with Bob. Bob shares with Carol, which inserts a second row. Alice
revokes Bob's row. Carol's row has its own `revoked_at`, still NULL, so Carol
keeps reading — and Alice's revoke returned success.

This is not a bug in the query. The query is a faithful reading of a table in
which the two rows are unrelated, which is exactly what the table says. Nothing
recorded that Carol's access was derived from Bob's.

The measurement is in the script beside this page, step 1: a three-deep chain,
the root revoked, and the flat predicate reports two of three grants live.

---

## The column, and what it has to mean

```sql
CREATE TABLE file_grant (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id         uuid NOT NULL,

    -- NULL: this authority came from a role or from ownership.
    -- Non-NULL: it came from another grant, and can never be more than it was.
    parent_grant_id uuid REFERENCES file_grant(id) ON DELETE CASCADE,

    subject_type    text NOT NULL,
    capabilities    text[] NOT NULL,
    expires_at      timestamptz,
    max_downloads   integer,
    download_count  integer NOT NULL DEFAULT 0,
    revoked_at      timestamptz,

    -- A child must concern the SAME FILE as its parent. This is the
    -- confused-deputy check for delegation, and it is a foreign key rather
    -- than a rule someone has to remember.
    UNIQUE (id, file_id),
    FOREIGN KEY (parent_grant_id, file_id) REFERENCES file_grant (id, file_id),

    CONSTRAINT grant_no_self_parent CHECK (parent_grant_id IS NULL OR parent_grant_id <> id)
);
```

The composite foreign key is the part that gets left out. Without it,
`parent_grant_id` says only "derived from some grant" — and a delegation whose
parent concerns a different file is a grant that passes every capability check
while pointing somewhere it was never authorized to point.

---

## The predicate

Liveness is a property of the chain. A grant is live when it is live **and
every ancestor is live**:

```sql
CREATE FUNCTION grant_is_live(p_grant_id uuid)
RETURNS boolean
LANGUAGE sql STABLE COST 100 AS $$
    WITH RECURSIVE chain AS (
        SELECT g.id, g.parent_grant_id, 1 AS depth,
               (    g.revoked_at IS NULL
                AND (g.expires_at IS NULL OR g.expires_at > now())
                AND (g.max_downloads IS NULL OR g.download_count < g.max_downloads)
               ) AS self_live
          FROM file_grant g
         WHERE g.id = p_grant_id
        UNION ALL
        SELECT p.id, p.parent_grant_id, c.depth + 1,
               (    p.revoked_at IS NULL
                AND (p.expires_at IS NULL OR p.expires_at > now())
                AND (p.max_downloads IS NULL OR p.download_count < p.max_downloads)
               )
          FROM chain c
          JOIN file_grant p ON p.id = c.parent_grant_id
         WHERE c.depth < 64
           AND c.self_live            -- stop at the first dead ancestor
    )
    SELECT coalesce(bool_and(chain.self_live), false)
           -- If we stopped because of the depth bound rather than because we
           -- ran out of ancestors, liveness is UNPROVEN. Deny.
           AND NOT EXISTS (
               SELECT 1 FROM chain d
                WHERE d.depth >= 64 AND d.parent_grant_id IS NOT NULL
           )
      FROM chain;
$$;
```

Three details in there are load-bearing and none of them is obvious.

**`coalesce(..., false)`.** An id that matches nothing produces an empty chain,
`bool_and` over no rows is NULL, and `WHERE NULL` is not an error — it is a row
that quietly fails to appear, or, in an `IF` in your application, a branch that
takes the else. Fail closed explicitly.

**The depth bound, and the `NOT EXISTS` beside it.** The bound alone is not a
safety property, it is a performance one: hitting it means the walk stopped
early, so what you have is a partial answer. Returning `bool_and` of a partial
walk returns `true` for a chain too long to verify. The `NOT EXISTS` turns
"I ran out of budget" into a denial, which is the only honest reading.

**`AND c.self_live` in the recursive term.** Without it the walk continues past
a dead ancestor to the root. With it, the walk stops at the first corpse.
Correctness is identical — `bool_and` would reach the same answer — and on a
revoked chain it is the difference between reading one row and reading
thirty-two.

Then state it once, in a view, so no caller can get it subtly wrong:

```sql
CREATE VIEW live_grant AS
SELECT * FROM file_grant
 WHERE revoked_at IS NULL AND grant_is_live(id);
```

`revoked_at IS NULL` there is logically redundant — `grant_is_live` already
requires it of the row itself. Keep it anyway. A function call is opaque to the
planner, so with only `grant_is_live(id)` in the predicate no partial index on
`file_grant` is usable from any query, and every revoked row pays for a
recursive CTE before being discarded. Measured on 6,001 grants with a tenth
revoked, the lookups went from a sequential scan filtering 6,001 rows to an
index scan filtering none. That measurement is not in the script beside this
page — it needs a populated table and an `EXPLAIN`, and it lives in
`packages/core/test/performance.test.ts`, which asserts both halves: that the
view still returns exactly the rows the one-conjunct version did, and that no
grant lookup filters rows an index should have discarded.

That is the shape of edit to be most careful about: removing it is a
correctness no-op and a performance regression, so the tests stay green and
every authorization decision gets slower.

---

## Attenuation: a child may be smaller, never bigger

Revocation is only half of it. The other half is that a delegated grant must
not be able to exceed what it was delegated from — otherwise the chain is a
formality and Bob mints himself something better than Bob had.

There are four dimensions, and people usually implement one.

### Capability

The obvious one. The child's set must be a subset:

```sql
IF NOT (NEW.capabilities <@ p.capabilities) THEN
    RAISE EXCEPTION 'grant_capability_amplification: % exceeds parent %',
        NEW.capabilities, p.capabilities;
END IF;
```

### Subject breadth, which is the one that gets missed

Capability attenuation alone lets this through: Bob holds `{read}` on the file,
for Bob. Bob delegates `{read}` — to **everyone**. A child whose subject is an
organization, or an anonymous public link, satisfies `capabilities <@ parent`
perfectly. One consultant's read access becomes a public URL and attenuation
was obeyed the whole way.

So breadth is attenuated too, and it does not depend on the parent's contents:
grant-derived authority may name a person or mint a bearer link, and nothing
wider.

```sql
IF NEW.subject_type NOT IN ('actor', 'link') THEN
    RAISE EXCEPTION
        'grant_subject_amplification: a delegated grant may only name an actor or a link, not %',
        NEW.subject_type;
END IF;
```

### Lifetime

A child may be shorter-lived, never longer. Clamp rather than refuse — a caller
asking for a week from an authority with a day left wants a day, not an error:

```sql
IF p.expires_at IS NOT NULL
   AND (NEW.expires_at IS NULL OR NEW.expires_at > p.expires_at) THEN
    NEW.expires_at := p.expires_at;
END IF;
```

Clamping silently is a trap of its own, so return the effective value to the
caller. A share endpoint that echoes back what was asked for rather than what
was stored is lying about its own output.

### Budget, and why it is not enough to check it once

Clamp the child against the parent's **remaining** budget:

```sql
IF p.max_downloads IS NOT NULL THEN
    v_remain := p.max_downloads - p.download_count;
    IF v_remain <= 0 THEN
        RAISE EXCEPTION 'grant_parent_exhausted: parent has no downloads left to delegate';
    END IF;
    IF NEW.max_downloads IS NULL OR NEW.max_downloads > v_remain THEN
        NEW.max_downloads := v_remain;
    END IF;
END IF;
```

That is correct at the instant of creation and worthless a millisecond later.
A parent with five downloads remaining can mint three children of five each —
each one legal when written — and you have sold fifteen.

**The fix is on the redemption side: a download consumes the budget of the
entire ancestor chain.** Then the parent's cap is a real budget over the whole
delegation tree, and exhaustion propagates downward for free, because an
exhausted ancestor is a dead ancestor and `grant_is_live` already says so.

Step 5 of the script measures it: a root capped at 5, three children each
created asking for 5, fifty concurrent redemptions spread across them — exactly
5 served.

Lock the chain in a deterministic order when you do it. Every transaction
touching a chain must take its row locks in the same order or two redemptions
on sibling branches will deadlock on their shared ancestors.

---

## The second statement that walks around all of it

Here is the failure that survives a careful trigger. Suppose attenuation is
enforced `BEFORE INSERT`. Bob inserts a perfectly legal child — one actor,
`{read}`. Then Bob runs:

```sql
UPDATE file_grant
   SET subject_type = 'org', subject_org_id = '...'
 WHERE id = '<the child>';
```

The insert was legal, the update never fires the trigger, and the delegated
grant now names an entire organization. Attenuation that binds only at INSERT
is attenuation a second statement walks around.

So the trigger covers updates, and the column list matters in both directions:

```sql
CREATE TRIGGER file_grant_attenuation
    BEFORE INSERT OR UPDATE OF parent_grant_id, capabilities, expires_at,
                               max_downloads, subject_type, subject_id,
                               subject_org_id, subject_min_role
    ON file_grant
    FOR EACH ROW EXECUTE FUNCTION file_grant_attenuate();
```

`UPDATE OF` rather than bare `UPDATE`, because this must **not** fire when a
redemption increments `download_count` or when a revoke sets `revoked_at` —
both of which legitimately make a parent non-live while its children are being
written. A trigger that re-validates attenuation on those statements refuses the
revoke that is doing its job.

Step 4 of the script measures both halves: with the subject columns in the
`UPDATE OF` list the widening is refused, and with an INSERT-only trigger the
identical statement succeeds.

And one more, which is what makes a cycle impossible rather than merely
unlikely:

```sql
IF TG_OP = 'UPDATE' AND NEW.parent_grant_id IS DISTINCT FROM OLD.parent_grant_id THEN
    RAISE EXCEPTION 'grant_lineage_immutable: parent_grant_id cannot be changed';
END IF;
```

Re-parenting is how a cycle gets created, and a cycle in a liveness graph is a
denial of service: every authorization check on any grant in the loop walks
until it hits the depth bound. The bound means the damage is bounded. Immutable
lineage means it never happens.

---

## Two bounds, and why they are different numbers

The function above stops walking at 64. The trigger refuses to create a chain
deeper than 32. Those are deliberately not the same number.

The creation bound is the policy: 32 hops of delegation is already far past any
real sharing pattern. The liveness bound is a *safety* bound on a recursive
query, and it has to sit above the creation bound so that a legal chain is never
the thing that trips it. If they were equal, a chain created at exactly the
limit would be refused at read time — access granted by a rule the system
immediately contradicts, which is the worst kind of bug to debug.

---

## Revocation is not the same question as "can this person still read it?"

This is the quiet half, and it is worth building the answer in from the start.

Your revoke endpoint takes a grant id. The caller's intent was almost always
about a *person*. Those differ whenever the person has access by more than one
route — a second share, an organization grant, their role, ownership. The call
succeeds, the chain is honoured, every descendant is dead, and the recipient
keeps reading through something else entirely.

So answer the question the caller meant:

- return, from the revoke, whether that subject can still read the file
- compute it by **re-running the read decision** inside the same transaction,
  not by counting surviving rows

Counting undercounts. A role grant with a `viewer` floor and one with an
`editor` floor are different subjects that both authorize an editor, so "no
grants left naming this subject" can be true while the person still has access.

And offer the operation the caller actually wanted — remove every live grant
naming this person, in one transaction. One transaction, not a loop over
`revoke()`: a loop opens one transaction per grant, and a failure partway leaves
some of a person's access removed and the rest live.

---

## What this still does not give you

Worth being plain about, because a security feature that oversells itself is
worse than one that does not exist.

- **Bytes already delivered are gone.** Revocation stops the next request. It
  does not reach a copy on somebody's laptop. If that is your threat model, you
  need DRM, and you should know that you are asking for something else.
- **A presigned redirect has a window.** If your download path redirects to a
  presigned URL, a revoked chain still works for whoever holds an unexpired
  redirect. Clamp that expiry to seconds and know that the window exists. See
  [Should I redirect to a presigned URL or proxy private files myself?](serving-private-files.md).
- **In-flight requests finish.** Revoking mid-stream does not kill a response
  already being written.
- **This binds writers, not readers of your database.** Anyone with SQL access
  can update `revoked_at` or drop the trigger. Constraints stop accidents and
  application bugs, which is most of what happens; they are not a privilege
  boundary.

---

## When you do not need any of this

If re-sharing is not a feature — if the only way to get access is through your
own share endpoint and the endpoint always issues from an org role — then every
grant is a root, every chain is one deep, and `revoked_at IS NULL` is the whole
predicate. Do that. A recursive CTE on the read path of every download is not
free, and buying it for a feature you do not have is a poor trade.

The question to ask is not "might someone forward a link" — they will, and a
forwarded link is still one grant. It is "**can a recipient mint a new grant?**"
If no, stop here.

---

## If you would rather not build it

[Filelayer](https://filelayer.dev) is this shape, packaged. `parent_grant_id`,
the recursive liveness function, the attenuation trigger with its `UPDATE OF`
list, chain-wide budget consumption and the two bounds are in its schema rather
than in application code — so they bind a migration and a psql session as well
as the library.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
await fl.orgs.create('acme', { owner: 'alice' });
const { id } = await fl.files.put(new TextEncoder().encode('REPORT'), {
  org: 'acme', owner: 'alice', name: 'report.pdf',
});

// Alice shares with Bob, including the right to pass it on. Bob, holding
// only that grant, shares onwards with Carol -- so Carol's grant is a
// child of Bob's, and `read` is a subset of what Bob holds.
const toBob = await fl.shares.create(id, {
  as: 'alice', withUser: 'bob', capabilities: ['read', 'share'],
});
const toCarol = await fl.shares.create(id, { as: 'bob', withUser: 'carol' });
assert.equal(toCarol.parentGrantId, toBob.grantId);

assert.equal((await fl.files.get(id, { as: 'carol' })).body.length, 6);

// Alice revokes BOB. Carol's grant was never touched.
const result = await fl.shares.revoke(toBob.grantId, { as: 'alice' });
assert.equal(result.subjectCanStillRead, false);

// Carol is out too, because her authority was Bob's.
await assert.rejects(
  () => fl.files.get(id, { as: 'carol' }),
  (e: { status?: number }) => e.status === 404,
);
```

That block is executed by `npm run check:docs` on every commit.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [How do I make a file link that expires — and that I can take back?](expiring-and-revocable-file-links.md) —
  why a presigned URL cannot be taken back, and the one query that is hard.
- [How do I do multi-tenant file access control?](multi-tenant-file-access.md) — the
  composite foreign key, applied to tenants rather than to lineage.
- [Should I redirect to a presigned URL or proxy private files myself?](serving-private-files.md) —
  where the revocation window comes from.

---

## Sources

- [WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html) — PostgreSQL, on recursive query evaluation and termination
- [CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html) — PostgreSQL, on `UPDATE OF column_name`
- [Capability-Based Computer Systems](https://homes.cs.washington.edu/~levy/capabook/) — Henry M. Levy, on attenuation and revocation in capability systems
- [ACLs don't](https://www.hpl.hp.com/techreports/2009/HPL-2009-20.html) — Tyler Close, on why delegation is the normal case rather than the exception
