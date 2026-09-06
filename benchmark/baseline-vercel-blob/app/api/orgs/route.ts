import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { appendAudit } from '@/lib/audit';
import { currentUser, route, newId } from '@/app/api/_lib/handler';

export const POST = (request: Request) =>
  route(async () => {
    const actor = currentUser(request);
    const { name } = (await request.json()) as { name: string };
    const orgId = newId('org');

    await sql`INSERT INTO orgs (id, name) VALUES (${orgId}, ${name})`;
    await sql`
      INSERT INTO memberships (org_id, user_id, role)
      VALUES (${orgId}, ${actor}, 'owner')
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'org.created',
      subjectType: 'org', subjectId: orgId, metadata: { name },
    });
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'membership.created',
      subjectType: 'user', subjectId: actor, metadata: { role: 'owner' },
    });
    return NextResponse.json({ id: orgId, name }, { status: 201 });
  });
