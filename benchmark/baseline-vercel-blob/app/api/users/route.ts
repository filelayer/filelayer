import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { route, newId } from '@/app/api/_lib/handler';

export const POST = (request: Request) =>
  route(async () => {
    const { email } = (await request.json()) as { email: string };
    const id = newId('usr');
    await sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`;
    return NextResponse.json({ id, email }, { status: 201 });
  });
