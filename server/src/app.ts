// The HTTP app: sign-in, the OpenWebUI routes under /api/owui, and the web page.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { COOKIE, seal, signIn, unseal, type Session } from './auth.js';
import type { Config } from './config.js';
import { HttpError } from './http.js';
import { OpenWebUiService, type ReplyEvent } from './openwebui/service.js';

const MB = 1024 * 1024;
type Upload = { originalname: string; buffer: Buffer; mimetype: string };
/** Multer gives names as Latin-1 */
const file = (f: Upload) => ({ name: Buffer.from(f.originalname, 'latin1').toString('utf8'), content: f.buffer, type: f.mimetype });

const id = z.string().min(1).max(300);
const settings = z.object({
  model: id,
  toolIds: z.array(id).max(50).default([]),
  knowledgeIds: z.array(id).max(50).default([]),
  features: z.object({ webSearch: z.boolean().default(false), codeInterpreter: z.boolean().default(false), imageGeneration: z.boolean().default(false) }).default({ webSearch: false, codeInterpreter: false, imageGeneration: false }),
  system: z.string().max(20_000).optional(),
});
const chatFile = z.object({ id, name: z.string().max(500), type: z.enum(['file', 'collection']), size: z.number().optional(), mime: z.string().max(100).optional() });
const sendSchema = z.object({
  chatId: z.string().uuid().optional(), content: z.string().max(100_000).default(''), files: z.array(chatFile).max(50).default([]),
  settings, editIndex: z.number().int().min(0).optional(), regenerate: z.boolean().optional(),
});
const chatPatch = z.object({ title: z.string().max(200).optional(), pinned: z.boolean().optional(), settings: settings.partial().optional() });
const agentSchema = z.object({
  name: z.string().trim().min(1).max(100), baseModelId: id, system: z.string().max(50_000).optional(), description: z.string().max(1000).optional(),
  knowledgeIds: z.array(id).max(50).optional(), toolIds: z.array(id).max(50).optional(), suggestions: z.array(z.string().max(500)).max(10).optional(),
});
const knowledgeSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional() });
const loginSchema = z.union([z.object({ email: z.string().trim().min(3).max(300), password: z.string().min(1).max(500) }), z.object({ apiKey: z.string().trim().min(10).max(500) })]);

type Authed = Request & { session?: Session };
const parse = <T extends z.ZodType>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? 'Bad request');
  return r.data;
};
const cookies = (req: Request) => Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

export function createApp(config: Config, opts: { fetchImpl?: typeof fetch } = {}) {
  const owui = new OpenWebUiService(config.openwebuiUrl, config.dataDir, opts.fetchImpl);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
  const upload = (n: number) => multer({ limits: { fileSize: 50 * MB, files: n } }).array('files', n);
  const h = (f: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    f(req as Authed, res).then(v => { if (!res.headersSent && v !== undefined) res.json(v); }).catch(next);
  };
  const setCookie = (res: Response, value: string, maxAge: number) => res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`);

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---- sign-in
  app.post('/api/login', h(async (req, res) => {
    const s = await signIn(config.openwebuiUrl, parse(loginSchema, req.body), config.sessionHours, opts.fetchImpl);
    setCookie(res, seal(config.sessionSecret, s), config.sessionHours * 3600);
    return { id: s.id, name: s.name, email: s.email, role: s.role };
  }));
  app.post('/api/logout', (_req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => {
    const s = unseal(config.sessionSecret, cookies(req)[COOKIE]);
    if (!s) { res.status(401).json({ message: 'Not signed in' }); return; }
    res.json({ id: s.id, name: s.name, email: s.email, role: s.role, openwebui: config.openwebuiUrl });
  });

  // Everything under /api/owui needs a session; a cross-site POST is refused
  app.use('/api/owui', (req: Authed, res, next) => {
    const s = unseal(config.sessionSecret, cookies(req)[COOKIE]);
    if (!s) { res.status(401).json({ message: 'Not signed in' }); return; }
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') { res.status(403).json({ message: 'Forbidden' }); return; }
    req.session = s;
    next();
  });
  const r = express.Router();
  r.get('/status', h(req => owui.status(req.session!)));
  r.get('/catalog', h(req => owui.catalog(req.session!)));
  r.get('/models', h(req => owui.models(req.session!)));
  r.get('/knowledge', h(req => owui.knowledge(req.session!)));
  r.get('/knowledge/:id', h(req => owui.knowledgeItem(req.session!, String(req.params.id))));
  r.post('/knowledge', h(req => owui.createKnowledge(req.session!, parse(knowledgeSchema, req.body))));
  r.post('/knowledge/:id/files', upload(20), h(async req => {
    let k = null;
    for (const f of (req.files as Upload[] | undefined) ?? []) k = await owui.addToKnowledge(req.session!, String(req.params.id), file(f));
    return k ?? owui.knowledgeItem(req.session!, String(req.params.id));
  }));
  r.delete('/knowledge/:id/files/:fileId', h(req => owui.removeFromKnowledge(req.session!, String(req.params.id), String(req.params.fileId))));
  r.delete('/knowledge/:id', h(async req => { await owui.deleteKnowledge(req.session!, String(req.params.id)); return { ok: true }; }));
  r.get('/tools', h(req => owui.tools(req.session!)));
  r.get('/functions', h(req => owui.functions(req.session!)));
  r.get('/prompts', h(req => owui.prompts(req.session!)));
  r.post('/agents', h(req => owui.createAgent(req.session!, parse(agentSchema, req.body))));
  r.delete('/agents/:id', h(async req => { await owui.deleteAgent(req.session!, String(req.params.id)); return { ok: true }; }));
  r.post('/files', upload(10), h(async req => {
    const out = [];
    for (const f of (req.files as Upload[] | undefined) ?? []) out.push(await owui.upload(req.session!, file(f)));
    return out;
  }));
  r.get('/chats', h(req => owui.list(req.session!)));
  r.get('/chats/:id', h(req => owui.get(req.session!, String(req.params.id))));
  r.patch('/chats/:id', h(req => owui.update(req.session!, String(req.params.id), parse(chatPatch, req.body))));
  r.delete('/chats/:id', h(async req => { await owui.remove(req.session!, String(req.params.id)); return { ok: true }; }));
  /** The answer as server-sent events: {type: 'chat'} first, then 'delta', 'sources', 'error', and 'done' last */
  r.post('/chats/stream', h(async (req, res) => {
    const b = parse(sendSchema, req.body);
    const stop = new AbortController();
    res.on('close', () => { if (!res.writableEnded) stop.abort(); });
    const write = (e: ReplyEvent | { type: 'error'; message: string }) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    const events = owui.reply(req.session!, b, stop.signal);
    const first = await events.next();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (!first.done) write(first.value);
    try { for await (const e of events) write(e); } catch (e) { write({ type: 'error', message: (e as Error).message }); }
    res.end();
  }));
  app.use('/api/owui', r);
  app.use('/api', (_req, res) => { res.status(404).json({ message: 'Not Found' }); });

  // The web page (web/dist); every other GET path is the page
  if (config.webDist && existsSync(join(config.webDist, 'index.html'))) {
    const index = join(config.webDist, 'index.html');
    app.use('/assets', express.static(join(config.webDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(config.webDist, { index: false, redirect: false }));
    app.get('/{*any}', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.sendFile(index); });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number }).status ?? 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(err);
    if (res.headersSent) { res.end(); return; }
    res.status(status).json({ message: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong' : (err as Error).message });
  });
  return app;
}
