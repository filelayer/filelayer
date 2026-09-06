/**
 * Shared route plumbing: error mapping and the stand-in for a real session
 * layer. Counted as application code, but it is genuinely the same on every
 * platform and is small.
 */
import { NextResponse } from 'next/server';
import { HttpError } from '@/lib/authz';

export function currentUser(request: Request): string {
  const id = request.headers.get('x-user-id');
  if (!id) throw new HttpError(401, 'unauthenticated');
  return id;
}

export async function route<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return NextResponse.json(result as object);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
