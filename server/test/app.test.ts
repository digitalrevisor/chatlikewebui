import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const OWUI = 'http://owui.test';
const users: Record<string, { id: string; name: string; email: string; role: string }> = {
  'tok-anna': { id: 'u-anna', name: 'Anna', email: 'anna@x.no', role: 'admin' },
  'sk-bob-0123456789': { id: 'u-bob', name: 'Bob', email: 'bob@x.no', role: 'user' },
};
const calls: { path: string; body?: unknown; auth: string }[] = [];
const sse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) { for (const t of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); },
}), { headers: { 'Content-Type': 'text/event-stream' } });

const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(/^Bearer /, '');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ path: url.pathname, body, auth });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/api/v1/auths/signin') return body.password === 'riktig' && body.email === 'anna@x.no' ? json({ ...users['tok-anna'], token: 'tok-anna' }) : json({ detail: 'Feil passord' }, 400);
  const me = users[auth];
  if (!me) return json({ detail: 'Not authenticated' }, 401);
  switch (url.pathname) {
    case '/api/v1/auths/': return json(me);
    case '/api/version': return json({ version: '0.6.40' });
    case '/api/models': return json({ data: [{ id: 'gpt-x', name: 'GPT X', owned_by: 'openai' }, { id: 'revisor', name: 'Revisor', info: { base_model_id: 'gpt-x', meta: { description: 'Agent' } } }] });
    case '/api/v1/knowledge/': return json([]);
    case '/api/v1/tools/': return json([{ id: 'web', name: 'Web' }]);
    case '/api/v1/functions/': return me.role === 'admin' ? json([]) : json({ detail: 'no' }, 403);
    case '/api/v1/prompts/': return json([]);
    case '/api/chat/completions': return sse(['Hei', ' på deg']);
    case '/api/v1/tasks/title/completions': return json({ choices: [{ message: { content: '{"title": "Hilsen"}' } }] });
  }
  return json({ detail: 'Not found' }, 404);
}) as typeof fetch;

let base = '';
let dir = '';
let close: () => void;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clw-'));
  const config: Config = { port: 0, openwebuiUrl: OWUI, sessionSecret: 'test-secret', sessionHours: 1, secureCookies: false, dataDir: dir, webDist: null };
  const server = createApp(config, { fetchImpl: fakeFetch }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => { close(); rmSync(dir, { recursive: true, force: true }); });

async function login(body: unknown) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
}
const get = (path: string, cookie = '') => fetch(`${base}${path}`, { headers: { cookie } });

test('signing in with e-mail and password, or an API key; wrong ones are refused', async () => {
  assert.equal((await login({ email: 'anna@x.no', password: 'feil' })).r.status, 401);
  assert.equal((await login({ apiKey: 'sk-wrong-0123456789' })).r.status, 401);
  const anna = await login({ email: 'anna@x.no', password: 'riktig' });
  assert.equal(anna.r.status, 200);
  assert.match(anna.r.headers.get('set-cookie')!, /HttpOnly/);
  assert.ok(!anna.cookie.includes('tok-anna'), 'the OpenWebUI token is not readable in the cookie');
  const me = await (await get('/api/me', anna.cookie)).json();
  assert.equal(me.name, 'Anna');
  const bob = await login({ apiKey: 'sk-bob-0123456789' });
  assert.equal((await (await get('/api/me', bob.cookie)).json()).role, 'user');
  assert.equal((await get('/api/owui/models')).status, 401);
  assert.equal((await get('/api/me', 'clw_session=tampered')).status, 401);
});

test('models, agents and the catalog come from OpenWebUI with the person\'s own token', async () => {
  const { cookie } = await login({ apiKey: 'sk-bob-0123456789' });
  const cat = await (await get('/api/owui/catalog', cookie)).json();
  assert.deepEqual(cat.models.map((m: { id: string; agent: boolean }) => [m.id, m.agent]), [['gpt-x', false], ['revisor', true]]);
  assert.equal(cat.functions.length, 0);
  assert.equal(calls.at(-1)!.auth, 'sk-bob-0123456789');
  const st = await (await get('/api/owui/status', cookie)).json();
  assert.equal(st.version, '0.6.40');
});

test('a streamed answer is saved, gets a title, and is only visible to its owner', async () => {
  const anna = await login({ email: 'anna@x.no', password: 'riktig' });
  const r = await fetch(`${base}/api/owui/chats/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: anna.cookie }, body: JSON.stringify({ content: 'Hei', settings: { model: 'revisor', toolIds: ['web'] } }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /event-stream/);
  const events = (await r.text()).split('\n\n').filter(Boolean).map(b => JSON.parse(b.slice(5)));
  assert.deepEqual(events.map(e => e.type), ['chat', 'delta', 'delta', 'done']);
  assert.equal(events.at(-1).message.content, 'Hei på deg');
  assert.equal(events.at(-1).title, 'Hilsen');
  const sent = calls.find(c => c.path === '/api/chat/completions')!.body as { model: string; tool_ids: string[]; stream: boolean };
  assert.equal(sent.model, 'revisor');
  assert.deepEqual(sent.tool_ids, ['web']);
  const id = events[0].chat.id;
  const list = await (await get('/api/owui/chats', anna.cookie)).json();
  assert.equal(list[0].title, 'Hilsen');
  const bob = await login({ apiKey: 'sk-bob-0123456789' });
  assert.equal((await get(`/api/owui/chats/${id}`, bob.cookie)).status, 404);
  assert.deepEqual(await (await get('/api/owui/chats', bob.cookie)).json(), []);
  const patched = await fetch(`${base}/api/owui/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: anna.cookie }, body: JSON.stringify({ pinned: true, title: 'Ny tittel' }) });
  assert.equal((await patched.json()).title, 'Ny tittel');
  assert.equal((await fetch(`${base}/api/owui/chats/${id}`, { method: 'DELETE', headers: { cookie: anna.cookie } })).status, 200);
  assert.equal((await get(`/api/owui/chats/${id}`, anna.cookie)).status, 404);
});

test('a cross-site write is refused and bad input is a 400', async () => {
  const { cookie } = await login({ apiKey: 'sk-bob-0123456789' });
  const cross = await fetch(`${base}/api/owui/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' });
  assert.equal(cross.status, 403);
  const bad = await fetch(`${base}/api/owui/chats/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ content: 'x' }) });
  assert.equal(bad.status, 400);
});
