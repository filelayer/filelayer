# The seeded bug of task 3

Both `*-t3-bug` folders are their arm's reference implementation with one
bug: **a viewer can create a share link**, which REQUIREMENTS.md forbids.
The report the agent gets is `prompts/task3-bug.md`.

## Arm B, `b-own-t3-bug`

The role check on `POST /orgs/{orgId}/documents/{documentId}/shares` is
missing:

    if (s.role === 'viewer') return s.deny(403, 'insufficient_role', { documentId: doc.id });

## Arm A, `a-filelayer-t3-bug`

The same role check is missing from the same route. Arm A's reference checks
roles twice: in the route, and in the grant it gives the org at upload
(`minRole: 'member'` with the `share` capability), which Filelayer enforces on
its own. Removing only the route's check would leave no bug to find, so the
seed also widens that grant to `minRole: 'viewer'`. The application then
behaves exactly as arm B's does.

## The fix, and what the scoring makes of it

The seed is not symmetric, and the scoring is built so that it does not have
to be. In arm B the bug is one missing line. In arm A it is two changes: the
route's check and the grant's floor.

- **Putting the route's role check back** fixes both arms, for every document.
  It is one line in each.
- **In arm A, narrowing the grant again** looks like a fix and is not one: it
  protects documents uploaded from then on, and every document uploaded while
  the bug was live keeps the wide grant.

So the database a task-3 snapshot is scored on is not empty. Before the
snapshot starts, the scorer starts the run's own seeded reference on the same
database and bucket and builds a world with it (`hidden/task3.mjs`,
`seedTask3`). T3-01 then checks a viewer against those documents, uploaded
while the bug was live, as well as against fresh ones. A fix that only narrows
the grant fails it.

Arm A has two places where the bug can be seen and arm B one. That is
declared in PREREG.md as a difference between the arms, not corrected.

## How it was checked

- Both seeded folders fail F16 and T3-01, and pass everything else.
- Both healthy references pass all of it, scored on a database seeded by
  their own seeded reference.
- Arm A's seeded folder with only the route's line restored passes all of it.
- Arm A's seeded folder with only the grant narrowed fails T3-01 on a document
  uploaded while the bug was live, and passes the rest.
