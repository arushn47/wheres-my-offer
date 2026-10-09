import { jwtVerify, SignJWT } from 'jose';

export interface SessionPayload {
  userId: string;
  email: string;
  name: string | null;
  avatar: string | null;
}

export function sessionKey(): Uint8Array {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[a-f\d]{64}$/i.test(key)) throw new Error('Session encryption key is not configured correctly');
  // Preserve the encoding used by existing seven-day sessions.
  return new TextEncoder().encode(key);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      algorithms: ['HS256'], requiredClaims: ['iat', 'exp'], maxTokenAge: '7d',
    });
    if (typeof payload.userId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(payload.userId) ||
        typeof payload.email !== 'string' || !/^[^\s@<>,"()]+@[^\s@<>,"()]+\.[^\s@<>,"()]+$/.test(payload.email) ||
        payload.email.length > 254 ||
        (payload.name != null && typeof payload.name !== 'string') ||
        (payload.avatar != null && typeof payload.avatar !== 'string')) return null;
    return { userId: payload.userId, email: payload.email, name: payload.name as string | null ?? null, avatar: payload.avatar as string | null ?? null };
  } catch { return null; }
}

export function signSessionToken(session: SessionPayload) {
  return new SignJWT({ ...session }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(sessionKey());
}
