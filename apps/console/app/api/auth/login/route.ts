import { NextResponse } from 'next/server';
import { z } from 'zod';
import { API_URL, SESSION_COOKIE } from '@/lib/session';

// Local development sign-in only works if the API was started with APEX_DEV_AUTH=1 (never in production).
// Production sign-in is Supabase Auth: set NEXT_PUBLIC_SUPABASE_URL and exchange its JWT here (NOT TESTED in this build — see docs/OPEN_RISKS.md).
export async function POST(req: Request) {
  const origin = req.headers.get('origin'); const host = req.headers.get('host');
  if (origin && new URL(origin).host !== host) return NextResponse.json({ error: 'bad_origin' }, { status: 403 });
  const body = z.object({ email: z.string().email() }).strict().safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  const r = await fetch(`${API_URL}/v1/dev/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.data) }).catch(() => null);
  if (!r) return NextResponse.json({ error: 'api_unreachable' }, { status: 502 });
  if (r.status === 404) return NextResponse.json({ error: 'dev_auth_disabled', message: 'Development sign-in is disabled. Configure Supabase Auth.' }, { status: 501 });
  if (!r.ok) return NextResponse.json({ error: 'login_failed' }, { status: 401 });
  const { token } = (await r.json()) as { token: string };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 8 });
  return res;
}
