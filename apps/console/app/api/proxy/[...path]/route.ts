import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, PROXY_ALLOW, SESSION_COOKIE } from '@/lib/session';

// Same-origin BFF: attaches the httpOnly session token server-side so the browser never holds a bearer token (XSS cannot exfiltrate it).
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = path.join('/');
  if (!PROXY_ALLOW.test(target) || target.includes('..')) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (req.method !== 'GET') {
    // CSRF: SameSite=Strict cookie + same-origin check + custom header that cross-site forms cannot set.
    const origin = req.headers.get('origin');
    if (!origin || new URL(origin).host !== req.headers.get('host') || req.headers.get('x-apex-csrf') !== '1')
      return NextResponse.json({ error: 'csrf_rejected' }, { status: 403 });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const idem = req.headers.get('idempotency-key'); if (idem) headers['idempotency-key'] = idem;
  if (req.method !== 'GET') headers['content-type'] = 'application/json';
  const r = await fetch(`${API_URL}/${target}${req.nextUrl.search}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text(), cache: 'no-store' }).catch(() => null);
  if (!r) return NextResponse.json({ error: 'api_unreachable', message: 'The APEX API is not reachable.' }, { status: 502 });
  return new NextResponse(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
}
export { handle as GET, handle as POST };
