import { jwtVerify, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';

const enc = (s: string) => new TextEncoder().encode(s);

export async function verifyBearer(req: FastifyRequest, secret: string): Promise<string | null> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(h.slice(7), enc(secret), { algorithms: ['HS256'], audience: 'authenticated' });
    const sub = payload.sub;
    if (typeof sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(sub)) return null;
    return sub;
  } catch { return null; }
}
export async function signDevToken(sub: string, secret: string) {
  return new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .setAudience('authenticated').setIssuedAt().setExpirationTime('8h').sign(enc(secret));
}
