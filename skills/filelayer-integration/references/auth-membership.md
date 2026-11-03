# Membership from your auth provider: Better Auth and Clerk

Filelayer keeps its own list of who belongs to which organization, and every
access decision reads it. Your auth provider is where membership really lives.
So the integration needs one small piece that copies membership across when it
changes, and every route needs to take the organization from the session.

Three rules, whichever provider you use:

1. **Mirror membership on the provider's membership events**, never on upload.
   `put({ org, owner })` into an organization that already exists refuses a
   user who is not a member (`403 no_membership`), and it is right to.
2. **Map roles explicitly, and map anything unknown to `viewer`.** A role your
   app invented later should not become `admin` by accident.
3. **The organization comes from the session.** Never from a form field, a query
   string or a JSON body. A client that names an organization it does not belong
   to is refused, but a route that reads the organization from the client teaches
   the wrong pattern to whoever copies it.

## Better Auth, with the organization plugin

Better Auth's default roles are `owner`, `admin` and `member`, the creator of an
organization is its `owner`, and a member's `role` can be a comma-separated
list. Its organization hooks run after Better Auth has written the change, and
in the member hooks `user` is the member being changed, not the person who made
the change. So the change is mirrored as an owner of the organization, read back
from Better Auth.

```ts
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { FilelayerError, type OrgRole } from '@filelayer/core';
import { fl } from './filelayer'; // your one Filelayer instance

const RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

// Strongest known role wins; a role this app invented maps to viewer.
function toFilelayerRole(role: string): OrgRole {
  const known = role.split(',').map((r) => r.trim())
    .filter((r): r is OrgRole => r in RANK);
  return known.sort((a, b) => RANK[b] - RANK[a])[0] ?? 'viewer';
}

async function anOwnerOf(organizationId: string, except: string): Promise<string> {
  const ctx = await auth.$context;
  const members = await ctx.adapter.findMany<{ userId: string; role: string }>({
    model: 'member',
    where: [{ field: 'organizationId', value: organizationId }],
  });
  const owner = members.find((m) => m.userId !== except && toFilelayerRole(m.role) === 'owner');
  if (!owner) throw new Error(`organization ${organizationId} has no owner`);
  return owner.userId;
}

async function mirrorMember(m: { organizationId: string; userId: string; role: string }) {
  const role = toFilelayerRole(m.role);
  if (role === 'owner') {
    try {
      // The creator. Creates the Filelayer organization; a retry is safe.
      await fl.orgs.create(m.organizationId, { owner: m.userId });
      return;
    } catch (e) {
      // Already exists: this is a second owner, set below.
      if (!(e instanceof FilelayerError && e.code === 'org_exists')) throw e;
    }
  }
  await fl.orgs.setRole(m.organizationId, m.userId, role, {
    as: await anOwnerOf(m.organizationId, m.userId),
  });
}

export const auth = betterAuth({
  // database, emailAndPassword, ...
  plugins: [
    organization({
      organizationHooks: {
        afterAddMember: ({ member }) => mirrorMember(member),
        afterAcceptInvitation: ({ member }) => mirrorMember(member),
        afterUpdateMemberRole: ({ member }) => mirrorMember(member),
        afterRemoveMember: async ({ member }) =>
          fl.orgs.removeMember(member.organizationId, member.userId, {
            as: await anOwnerOf(member.organizationId, member.userId),
          }),
      },
    }),
  ],
});
```

There is no `afterCreateOrganization` hook here on purpose: creating an
organization also adds its creator as a member, and that `afterAddMember` call
already creates the Filelayer organization. An ownership transfer works in the
order Better Auth allows it: promote the new owner first, then demote the old
one, and each step is mirrored.

Then, in a route, the organization is the session's active one:

```ts
import { headers } from 'next/headers';

const session = await auth.api.getSession({ headers: await headers() });
if (!session) return new Response(null, { status: 401 });
const org = session.session.activeOrganizationId;
if (!org) return new Response('Choose an organization first', { status: 409 });

const { id } = await fl.files.put(bytes, { org, owner: session.user.id, name, contentType });
```

Checked against Better Auth 1.7.16 with its organization plugin, the real
`betterAuth()` and a real Filelayer instance: the creator becomes the owner, an
added admin can read, an accepted invitation becomes a member, a demotion takes
away the audit log, an ownership transfer leaves the old owner unable to demote
the new one, and a removed member is refused on the next read.

## Clerk

Clerk's organization roles are `org:admin` and `org:member` by default, and
there is no owner role: the user who created the organization is in the
`organization.created` event as `created_by`. Membership changes arrive as
`organizationMembership.created`, `.updated` and `.deleted` webhooks, with the
organization in `organization.id`, the user in `public_user_data.user_id` and the
role in `role`. This recipe follows the same shape as the Better Auth one. It
type-checks against `@clerk/nextjs`, and it has not been run, because Clerk
needs a live account.

```ts
// app/api/webhooks/clerk/route.ts. Make this route public in your Clerk middleware.
import type { NextRequest } from 'next/server';
import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { OrgRole } from '@filelayer/core';
import { fl } from '@/lib/filelayer';

const ROLES: Record<string, OrgRole> = { 'org:admin': 'admin', 'org:member': 'member' };
const toFilelayerRole = (role: string): OrgRole => ROLES[role] ?? 'viewer';

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch {
    return new Response('Verification failed', { status: 400 });
  }

  if (evt.type === 'organization.created' && evt.data.created_by) {
    await fl.orgs.create(evt.data.id, { owner: evt.data.created_by });
  }
  if (evt.type === 'organizationMembership.created' || evt.type === 'organizationMembership.updated') {
    const { organization, public_user_data, role } = evt.data;
    if (public_user_data.user_id !== organization.created_by) {
      await fl.orgs.setRole(organization.id, public_user_data.user_id, toFilelayerRole(role), {
        as: organization.created_by!,
      });
    }
  }
  if (evt.type === 'organizationMembership.deleted') {
    const { organization, public_user_data } = evt.data;
    await fl.orgs.removeMember(organization.id, public_user_data.user_id, {
      as: organization.created_by!,
    });
  }
  return new Response('OK');
}
```

Clerk delivers webhooks asynchronously and retries them, so a new member can
reach your app before their webhook does. Their first upload is then refused
with `no_membership` until the event arrives. If the creator leaves the
organization, `created_by` stops being a usable owner: store the owner you
created the Filelayer organization with and use that instead. In a route, take
the organization from `auth()`, as `orgId`, never from the request.

## When the mirror fails

Both providers have already committed the change when your code runs. If the
Filelayer call throws, the two lists disagree until it succeeds. Every call above
is safe to repeat: `orgs.create` with the same owner returns the same
organization, and `setRole` and `removeMember` set a state rather than toggle
one. Log the failure and retry it, or rerun the mirror for that organization.
