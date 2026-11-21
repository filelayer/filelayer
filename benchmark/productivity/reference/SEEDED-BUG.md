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

## The fix

The smallest fix is the same line in both arms: put the route's role check
back. In arm A, narrowing the grant again is a second way to fix it for new
uploads, but not for documents already uploaded under the wide grant, which
keep it. Both kinds of fix pass the hidden check of task 3 (T3-01), which
uploads fresh documents.

## How it was checked

- Both seeded folders fail F16 and T3-01, and pass everything else.
- Both healthy references pass all of it.
- Arm A's seeded folder with only the route's line restored passes all of it.
