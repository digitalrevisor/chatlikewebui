// Calls to the app's own server. A 401 means the sign-in ended: the page shows the sign-in again.
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const SIGNED_OUT = 'clw-signed-out';

export async function errorOf(r: Response) {
  const body = await r.json().catch(() => ({})) as { message?: unknown };
  if (r.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  return new ApiError(r.status, typeof body.message === 'string' ? body.message : 'Noe gikk galt');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw await errorOf(r);
  return r.json() as Promise<T>;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T = unknown>(path: string, body?: unknown) => call<T>('POST', path, body ?? {});
export const patch = <T = unknown>(path: string, body: unknown) => call<T>('PATCH', path, body);
export const del = <T = unknown>(path: string) => call<T>('DELETE', path);

export interface Me { id: string; name: string; email: string; role: string; openwebui?: string }
