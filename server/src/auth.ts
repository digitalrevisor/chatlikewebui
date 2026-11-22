// Signing in: with the person's own OpenWebUI e-mail and password, or an OpenWebUI API key. The OpenWebUI token they
// get is kept in an encrypted, HttpOnly cookie, so the browser never sees it and the server keeps no sessions.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { OpenWebUiClient, OpenWebUiError } from './openwebui/client.js';
import { HttpError } from './http.js';

export interface Session { id: string; name: string; email: string; role: string; token: string; exp: number }
export const COOKIE = 'clw_session';

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

export function seal(secret: string, s: Session): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function unseal(secret: string, token: string | undefined): Session | null {
  if (!token) return null;
  try {
    const bin = Buffer.from(token, 'base64url');
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), bin.subarray(0, 12));
    d.setAuthTag(bin.subarray(12, 28));
    const s = JSON.parse(Buffer.concat([d.update(bin.subarray(28)), d.final()]).toString('utf8')) as Session;
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

/** Ids become folder names: anything else than letters, digits, - and _ is replaced */
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'user';

/** Signs in to OpenWebUI and returns the session to keep */
export async function signIn(url: string, b: { email?: string; password?: string; apiKey?: string }, hours: number, fetchImpl: typeof fetch = fetch): Promise<Session> {
  const exp = Date.now() + hours * 3_600_000;
  try {
    if (b.apiKey) {
      const c = new OpenWebUiClient({ url, apiKey: b.apiKey.trim() }, fetchImpl);
      const me = await c.json<{ id?: string; name?: string; email?: string; role?: string }>('GET', '/api/v1/auths/', undefined, 15_000);
      if (!me.id) throw new HttpError(401, 'Ugyldig API-nøkkel');
      return { id: safeId(me.id), name: me.name ?? '', email: me.email ?? '', role: me.role ?? 'user', token: b.apiKey.trim(), exp };
    }
    const r = await fetchImpl(`${url}/api/v1/auths/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: b.email, password: b.password }), signal: AbortSignal.timeout(15_000) });
    const me = await r.json().catch(() => null) as { id?: string; name?: string; email?: string; role?: string; token?: string; detail?: string } | null;
    if (!r.ok || !me?.token) throw new HttpError(401, me?.detail || 'Feil e-post eller passord');
    if (!me.id) throw new HttpError(503, 'OpenWebUI svarte uten bruker-id');
    if (me.role === 'pending') throw new HttpError(403, 'Kontoen venter på godkjenning i OpenWebUI');
    return { id: safeId(me.id ?? ''), name: me.name ?? '', email: me.email ?? '', role: me.role ?? 'user', token: me.token, exp };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof OpenWebUiError) throw new HttpError(e.status === 0 ? 503 : 401, e.status === 0 ? e.message : 'Ugyldig API-nøkkel');
    throw new HttpError(503, `OpenWebUI could not be reached: ${(e as Error).message}`);
  }
}
