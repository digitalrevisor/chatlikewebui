// The OpenWebUI instance (OPENWEBUI_URL, OPENWEBUI_API_KEY): models and agents, chat completions with streaming, files,
// knowledge, tools, functions and prompts. Every call goes through this client, so the key never reaches the browser
// and tests can hand in their own fetch.

export interface OpenWebUiConfig {
  /** Base address without a trailing slash, e.g. http://217.149.113.34:3000 */
  url: string;
  /** An API key from OpenWebUI (Settings → Account → API keys). An admin's key also lists functions. */
  apiKey: string;
}

/** The instance (OPENWEBUI_URL) and an optional server key used when a company has none of its own (OPENWEBUI_API_KEY) */
export interface OpenWebUiConnection { url: string | null; serverKey: string | null; fetchImpl?: typeof fetch }

export const DEFAULT_OPENWEBUI_URL = 'http://217.149.113.34:3000';

export function openWebUiConnection(env: NodeJS.ProcessEnv = process.env): OpenWebUiConnection {
  const url = (env.OPENWEBUI_URL ?? DEFAULT_OPENWEBUI_URL).trim().replace(/\/+$/, '');
  return { url: url || null, serverKey: (env.OPENWEBUI_API_KEY ?? '').trim() || null };
}

/** An error answer from OpenWebUI, with its HTTP status (0: not reachable) */
export class OpenWebUiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Fetch = typeof fetch;
const TIMEOUT = 120_000;

/** OpenWebUI's error bodies: {detail: "..."} or {detail: [{msg}]} (FastAPI), or OpenAI's {error: {message}} */
export function errorText(body: unknown, status: number): string {
  const b = body as { detail?: unknown; error?: { message?: string } | string; message?: string } | null;
  if (typeof b?.detail === 'string') return b.detail;
  if (Array.isArray(b?.detail)) return b.detail.map(d => (d as { msg?: string }).msg ?? '').filter(Boolean).join('; ') || `OpenWebUI answered ${status}`;
  if (typeof b?.error === 'string') return b.error;
  if (b?.error?.message) return b.error.message;
  if (typeof b?.message === 'string') return b.message;
  return `OpenWebUI answered ${status}`;
}

export class OpenWebUiClient {
  constructor(readonly config: OpenWebUiConfig | null, private readonly fetchImpl: Fetch = fetch) {}

  get configured() { return !!this.config; }

  private cfg(): OpenWebUiConfig {
    if (!this.config) throw new OpenWebUiError(503, 'openwebui.notconfigured');
    return this.config;
  }

  private async send(method: string, path: string, init: { json?: unknown; form?: FormData; signal?: AbortSignal; timeout?: number } = {}) {
    const c = this.cfg();
    const headers: Record<string, string> = { Authorization: `Bearer ${c.apiKey}`, Accept: 'application/json' };
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeout ?? TIMEOUT)]) : AbortSignal.timeout(init.timeout ?? TIMEOUT);
    try {
      return await this.fetchImpl(`${c.url}${path}`, { method, headers, body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined), signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError' && init.signal?.aborted) throw e;
      throw new OpenWebUiError(0, `OpenWebUI could not be reached: ${(e as Error).message}`);
    }
  }

  /** A JSON call; throws OpenWebUiError on an error answer */
  async json<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeout?: number): Promise<T> {
    const r = await this.send(method, path, { json: body, timeout });
    const text = await r.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new OpenWebUiError(r.status, errorText(data, r.status));
    return data as T;
  }

  /** A file's bytes (GET /api/v1/files/{id}/content) */
  async content(id: string): Promise<Buffer> {
    const r = await this.send('GET', `/api/v1/files/${encodeURIComponent(id)}/content`);
    if (!r.ok) throw new OpenWebUiError(r.status, errorText(await r.json().catch(() => null), r.status));
    return Buffer.from(await r.arrayBuffer());
  }

  /** Multipart upload (files) */
  async upload<T = unknown>(path: string, file: { name: string; content: Buffer; type?: string }): Promise<T> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(file.content)], { type: file.type || 'application/octet-stream' }), file.name);
    const r = await this.send('POST', path, { form, timeout: 300_000 });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new OpenWebUiError(r.status, errorText(data, r.status));
    return data as T;
  }

  /** POST /api/chat/completions with stream: true; the raw response, whose body is server-sent events */
  async stream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const r = await this.send('POST', '/api/chat/completions', { json: { ...body, stream: true }, signal, timeout: 900_000 });
    if (!r.ok) {
      const data = await r.json().catch(() => null);
      throw new OpenWebUiError(r.status, errorText(data, r.status));
    }
    return r;
  }
}

/** One parsed event of an OpenAI-style stream: the text to add, sources (citations), usage, or the end */
export type StreamEvent = { type: 'delta'; text: string } | { type: 'sources'; sources: Source[] } | { type: 'usage'; usage: Record<string, unknown> } | { type: 'error'; message: string } | { type: 'done' };
export interface Source { name: string; url?: string; snippet?: string }

/** OpenWebUI sends sources as {source: {name, url?}, document: [text...], metadata: [{source, name}]} */
export function sourcesOf(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  const out: Source[] = [];
  for (const s of raw as { source?: { name?: string; url?: string; id?: string }; document?: string[]; metadata?: { source?: string; name?: string }[] }[]) {
    const name = s.source?.name || s.metadata?.[0]?.name || s.metadata?.[0]?.source || s.source?.id || 'Kilde';
    const url = s.source?.url || (/^https?:\/\//.test(s.metadata?.[0]?.source ?? '') ? s.metadata![0]!.source : undefined);
    const snippet = (s.document?.[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
    if (!out.some(o => o.name === name && o.url === url)) out.push({ name, ...(url ? { url } : {}), ...(snippet ? { snippet } : {}) });
  }
  return out;
}

/** Parses the lines of one `data:` event into what the chat needs */
export function parseEvent(data: string): StreamEvent[] {
  const d = data.trim();
  if (!d) return [];
  if (d === '[DONE]') return [{ type: 'done' }];
  let j: Record<string, unknown>;
  try { j = JSON.parse(d) as Record<string, unknown>; } catch { return []; }
  const out: StreamEvent[] = [];
  if (j.error) out.push({ type: 'error', message: errorText(j, 500) });
  if (j.sources || j.citations) out.push({ type: 'sources', sources: sourcesOf(j.sources ?? j.citations) });
  const choices = j.choices as { delta?: { content?: string | null; reasoning_content?: string | null } }[] | undefined;
  const text = choices?.[0]?.delta?.content;
  if (typeof text === 'string' && text) out.push({ type: 'delta', text });
  if (j.usage && typeof j.usage === 'object') out.push({ type: 'usage', usage: j.usage as Record<string, unknown> });
  return out;
}

/** Reads a server-sent event stream and yields its parsed events */
export async function* readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield* parseEvent(line.slice(5));
      }
    }
    buf += decoder.decode();
    if (buf.startsWith('data:')) yield* parseEvent(buf.slice(5));
  } finally {
    reader.releaseLock();
  }
}
