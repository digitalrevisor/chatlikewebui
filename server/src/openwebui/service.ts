// The chat's work against OpenWebUI: what the instance offers (models, agents, knowledge, tools, functions, prompts),
// the person's conversations, and answers streamed from /api/chat/completions. Every call uses the person's own
// OpenWebUI token, so OpenWebUI's own rights decide what they may see and change.
import { join } from 'node:path';
import { HttpError } from '../http.js';
import type { Session } from '../auth.js';
import { ChatStore, contextKey, type Chat, type ChatContext, type ChatFile, type ChatMessage, type ChatSettings } from './chat-store.js';
import { OpenWebUiClient, OpenWebUiError, readStream, type Source } from './client.js';

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = <T = Raw>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : Array.isArray((v as { items?: unknown })?.items) ? (v as { items: T[] }).items : Array.isArray((v as { data?: unknown })?.data) ? (v as { data: T[] }).data : []);
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_IMAGE = 8 * 1024 * 1024;

export interface ModelView {
  id: string; name: string; description: string; image: string | null;
  /** An OpenWebUI custom model (base model + instructions, knowledge, tools); shown as an agent */
  agent: boolean; baseModelId: string | null; ownedBy: string;
  knowledgeIds: string[]; toolIds: string[]; suggestions: string[]; tags: string[];
}

/** /api/models answers {data: [...]}; agents carry info.base_model_id and info.meta */
export function modelView(m: Raw): ModelView {
  const info = (m.info ?? {}) as Raw;
  const meta = ((info.meta ?? m.meta ?? {}) as Raw);
  const base = str(info.base_model_id) || null;
  const knowledge = list<Raw>(meta.knowledge).map(k => str(k.id)).filter(Boolean);
  const suggestions = list<Raw>(meta.suggestion_prompts).map(s => str(s.content)).filter(Boolean);
  return {
    id: str(m.id), name: str(m.name) || str(m.id), description: str(meta.description), image: str(meta.profile_image_url) || null,
    agent: !!base || m.preset === true, baseModelId: base, ownedBy: str(m.owned_by),
    knowledgeIds: knowledge, toolIds: (Array.isArray(meta.toolIds) ? meta.toolIds as unknown[] : []).map(String), suggestions,
    tags: list<Raw>(m.tags ?? meta.tags).map(t => str(t.name)).filter(Boolean),
  };
}

export function knowledgeView(k: Raw) {
  const files = list<Raw>(k.files ?? (k.data as Raw | undefined)?.file_ids);
  return {
    id: str(k.id), name: str(k.name), description: str(k.description),
    files: files.map(f => (typeof f === 'string' ? { id: f, name: f, size: null } : { id: str(f.id), name: str((f.meta as Raw | undefined)?.name) || str(f.filename) || str(f.id), size: Number((f.meta as Raw | undefined)?.size) || null })),
    updatedAt: k.updated_at ? new Date(Number(k.updated_at) * 1000).toISOString() : null,
  };
}

/** The first words of the question, until a better title comes */
export function quickTitle(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t || 'Ny samtale';
}

/** An agent's id: its name in lower case, a-z, 0-9 and dashes, with a short random end so names can repeat */
export function agentId(name: string) {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/æ/gi, 'ae').replace(/ø/gi, 'o').replace(/å/gi, 'a')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
  return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/** What the person sends: the text, files already uploaded, and how to answer */
export interface SendInput {
  chatId?: string;
  content: string;
  files: ChatFile[];
  settings: ChatSettings;
  /** Answer the question at this index again, with new text (edit) */
  editIndex?: number;
  /** Throw away the last answer and answer again */
  regenerate?: boolean;
  /** A risk page, workpaper or bank transaction the conversation belongs to */
  context?: ChatContext;
}

/** Instructions for this message's place (sent each time, not stored), and the message with its tags filled in */
export type Prepare = (content: string) => Promise<{ system: string; content: string }>;

export type ReplyEvent =
  | { type: 'chat'; chat: { id: string; title: string } }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'error'; message: string }
  | { type: 'done'; message: ChatMessage; title: string };

export class OpenWebUiService {
  readonly store: ChatStore;

  constructor(private readonly url: string, dataDir: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.store = new ChatStore(join(dataDir, 'chats'));
  }

  /** A client with the person's own OpenWebUI token */
  client(u: Session) {
    return new OpenWebUiClient({ url: this.url, apiKey: u.token }, this.fetchImpl);
  }

  /** Calls OpenWebUI with the person's key and turns its errors into answers the page can show */
  private async call<T>(u: Session, f: (c: OpenWebUiClient) => Promise<T>): Promise<T> {
    const c = this.client(u);
    try { return await f(c); } catch (e) {
      if (!(e instanceof OpenWebUiError)) throw e;
      if (e.status === 401 || e.status === 403) throw new HttpError(e.status === 401 ? 401 : 403, `OpenWebUI: ${e.message}`);
      if (e.status === 404) throw new HttpError(404, `OpenWebUI: ${e.message}`);
      if (e.status >= 400 && e.status < 500) throw new HttpError(400, `OpenWebUI: ${e.message}`);
      throw new HttpError(503, `OpenWebUI: ${e.message}`);
    }
  }

  // ---- what the instance offers

  async status(u: Session) {
    try {
      const v = await this.client(u).json<{ version?: string }>('GET', '/api/version', undefined, 10_000);
      return { reachable: true, version: v?.version ?? null, url: this.url };
    } catch (e) {
      return { reachable: false, version: null, url: this.url, error: (e as Error).message };
    }
  }

  async models(u: Session) {
    const r = await this.call(u, c => c.json<Raw>('GET', '/api/models'));
    // Arena models and hidden ones are left out, as in OpenWebUI's own picker
    return list<Raw>(r).filter(m => !m.arena && !((m.info as Raw | undefined)?.meta as Raw | undefined)?.hidden).map(modelView).filter(m => m.id);
  }

  async knowledge(u: Session) {
    return list<Raw>(await this.call(u, c => c.json('GET', '/api/v1/knowledge/'))).map(knowledgeView);
  }

  async knowledgeItem(u: Session, id: string) {
    return knowledgeView(await this.call(u, c => c.json<Raw>('GET', `/api/v1/knowledge/${encodeURIComponent(id)}`)));
  }

  async tools(u: Session) {
    return list<Raw>(await this.call(u, c => c.json('GET', '/api/v1/tools/')))
      .map(t => ({ id: str(t.id), name: str(t.name) || str(t.id), description: str((t.meta as Raw | undefined)?.description) }));
  }

  /** Filters, actions and pipes. Only an admin key may list them; with another key the list is empty. */
  async functions(u: Session) {
    try {
      const r = await this.call(u, c => c.json('GET', '/api/v1/functions/'));
      return list<Raw>(r).map(f => ({ id: str(f.id), name: str(f.name) || str(f.id), type: str(f.type), active: f.is_active !== false, global: f.is_global === true, description: str((f.meta as Raw | undefined)?.description) }));
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return [];
      throw e;
    }
  }

  async prompts(u: Session) {
    return list<Raw>(await this.call(u, c => c.json('GET', '/api/v1/prompts/')))
      .map(p => ({ command: str(p.command).replace(/^\//, ''), title: str(p.title) || str(p.name), content: str(p.content) })).filter(p => p.command && p.content);
  }

  /** Everything the chat page needs at once; a part OpenWebUI refuses is left empty */
  async catalog(u: Session) {
    const safe = async <T>(f: () => Promise<T[]>) => { try { return await f(); } catch { return [] as T[]; } };
    const [models, knowledge, tools, functions, prompts] = await Promise.all([this.models(u), safe(() => this.knowledge(u)), safe(() => this.tools(u)), safe(() => this.functions(u)), safe(() => this.prompts(u))]);
    return { models, knowledge, tools, functions, prompts };
  }

  // ---- files and knowledge

  /** Uploads a file to OpenWebUI and waits until it is read (so it can be searched); returns it as the chat refers to it */
  async upload(u: Session, file: { name: string; content: Buffer; type?: string }): Promise<ChatFile> {
    const r = await this.call(u, c => c.upload<Raw>('/api/v1/files/', file));
    const id = str(r.id);
    if (!id) throw new HttpError(503, 'OpenWebUI: no file id');
    await this.waitProcessed(this.client(u), id);
    const image = IMAGE.test(file.type ?? '') && file.content.length <= MAX_IMAGE;
    return { id, name: str(r.filename) || file.name, type: 'file', size: file.content.length, ...(image ? { mime: file.type!.toLowerCase() } : {}) };
  }

  /** Newer OpenWebUI versions read files in the background; older ones answer 404 here because they are done already */
  private async waitProcessed(api: OpenWebUiClient, id: string, tries = 60) {
    for (let i = 0; i < tries; i++) {
      let s: { status?: string; error?: string } | null;
      try { s = await api.json('GET', `/api/v1/files/${encodeURIComponent(id)}/process/status`, undefined, 10_000); } catch { return; }
      if (!s?.status || s.status === 'completed') return;
      if (s.status === 'failed') throw new HttpError(400, `OpenWebUI: ${s.error || 'could not read the file'}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async createKnowledge(u: Session, b: { name: string; description?: string }) {
    // access_control {} keeps it private to the key's owner in OpenWebUI
    return knowledgeView(await this.call(u, c => c.json<Raw>('POST', '/api/v1/knowledge/create', { name: b.name, description: b.description ?? '', access_control: {} })));
  }

  async addToKnowledge(u: Session, knowledgeId: string, file: { name: string; content: Buffer; type?: string }) {
    const f = await this.upload(u, file);
    await this.call(u, c => c.json('POST', `/api/v1/knowledge/${encodeURIComponent(knowledgeId)}/file/add`, { file_id: f.id }, 300_000));
    return this.knowledgeItem(u, knowledgeId);
  }

  async removeFromKnowledge(u: Session, knowledgeId: string, fileId: string) {
    await this.call(u, c => c.json('POST', `/api/v1/knowledge/${encodeURIComponent(knowledgeId)}/file/remove`, { file_id: fileId }));
    return this.knowledgeItem(u, knowledgeId);
  }

  async deleteKnowledge(u: Session, id: string) {
    await this.call(u, c => c.json('DELETE', `/api/v1/knowledge/${encodeURIComponent(id)}/delete`));
  }

  // ---- agents (custom models)


  async createAgent(u: Session, b: { name: string; baseModelId: string; system?: string; description?: string; knowledgeIds?: string[]; toolIds?: string[]; suggestions?: string[] }) {
    const all = b.knowledgeIds?.length ? await this.knowledge(u).catch(() => []) : [];
    const knowledge = (b.knowledgeIds ?? []).map(id => { const k = all.find(x => x.id === id); return { id, name: k?.name ?? id, description: k?.description ?? '', type: 'collection' }; });
    const body = {
      id: agentId(b.name), base_model_id: b.baseModelId, name: b.name,
      meta: {
        profile_image_url: '/static/favicon.png', description: b.description ?? '', knowledge, toolIds: b.toolIds ?? [],
        suggestion_prompts: (b.suggestions ?? []).filter(Boolean).map(content => ({ content })), tags: [{ name: 'digitalrevisor' }],
      },
      params: b.system ? { system: b.system } : {},
      access_control: {}, is_active: true,
    };
    return modelView(await this.call(u, c => c.json<Raw>('POST', '/api/v1/models/create', body)));
  }

  /** Newer versions: /models/model/delete?id=; older: /models/delete?id= */
  async deleteAgent(u: Session, id: string) {
    const q = `?id=${encodeURIComponent(id)}`;
    await this.call(u, async c => {
      try { await c.json('DELETE', `/api/v1/models/model/delete${q}`); } catch (e) {
        if (!(e instanceof OpenWebUiError) || ![404, 405].includes(e.status)) throw e;
        await c.json('DELETE', `/api/v1/models/delete${q}`);
      }
    });
  }

  // ---- conversations

  list(u: Session, context = '') { return this.store.list(u.id, context); }

  async get(u: Session, id: string) {
    const c = await this.store.get(u.id, id);
    if (!c) throw new HttpError(404, 'Fant ikke samtalen');
    return c;
  }

  async update(u: Session, id: string, b: { title?: string; pinned?: boolean; settings?: Partial<ChatSettings> }) {
    const c = await this.get(u, id);
    if (b.title !== undefined) c.title = b.title.trim().slice(0, 200) || c.title;
    if (b.pinned !== undefined) c.pinned = b.pinned;
    if (b.settings) c.settings = { ...c.settings, ...b.settings };
    return this.store.save(c, false);
  }

  remove(u: Session, id: string) { return this.store.remove(u.id, id); }

  /** An image's bytes as a data URL, for models that can see images */
  private async imageUrl(api: OpenWebUiClient, f: ChatFile) {
    try {
      const bytes = await api.content(f.id);
      return bytes.length <= MAX_IMAGE ? `data:${f.mime};base64,${bytes.toString('base64')}` : null;
    } catch { return null; }
  }

  /** The messages OpenWebUI gets: the conversation's own instructions first, images inline */
  private async payloadMessages(api: OpenWebUiClient, c: Chat, context = '') {
    const out: Raw[] = [];
    const system = [context.trim(), c.settings.system?.trim()].filter(Boolean).join('\n\n');
    if (system) out.push({ role: 'system', content: system });
    for (const m of c.messages) {
      if (m.role === 'assistant' && !m.content) continue;
      const images = m.role === 'user' ? (m.files ?? []).filter(f => f.mime) : [];
      const urls = (await Promise.all(images.map(f => this.imageUrl(api, f)))).filter((x): x is string => !!x);
      out.push(urls.length ? { role: m.role, content: [{ type: 'text', text: m.content }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] } : { role: m.role, content: m.content });
    }
    return out;
  }

  /** Every file of the conversation and the chosen knowledge, so earlier attachments still count */
  private payloadFiles(c: Chat) {
    const files = new Map<string, { type: string; id: string }>();
    for (const m of c.messages) for (const f of m.files ?? []) if (!f.mime) files.set(f.id, { type: f.type, id: f.id });
    for (const id of c.settings.knowledgeIds) files.set(id, { type: 'collection', id });
    return [...files.values()];
  }

  /** Sends the question and streams the answer; the conversation is saved before the first word and after the last */
  async *reply(u: Session, input: SendInput, signal: AbortSignal, prepare?: Prepare): AsyncGenerator<ReplyEvent> {
    const api = this.client(u);
    let c: Chat;
    if (input.chatId) {
      c = await this.get(u, input.chatId);
      if (contextKey(c.context) !== contextKey(input.context)) throw new HttpError(400, 'Ugyldig forespørsel');
    } else c = this.store.create(u.id, input.settings, quickTitle(input.content), input.context);
    let system = '';
    if (prepare && !input.regenerate) {
      const p = await prepare(input.content);
      system = p.system;
      input = { ...input, content: p.content };
    } else if (prepare) system = (await prepare('')).system;
    c.settings = input.settings;
    const now = () => new Date().toISOString();
    if (input.regenerate) {
      while (c.messages.at(-1)?.role === 'assistant') c.messages.pop();
      if (!c.messages.length) throw new HttpError(400, 'Ugyldig forespørsel');
    } else {
      if (input.editIndex !== undefined) {
        if (c.messages[input.editIndex]?.role !== 'user') throw new HttpError(400, 'Ugyldig forespørsel');
        c.messages = c.messages.slice(0, input.editIndex);
      }
      if (!input.content.trim() && !input.files.length) throw new HttpError(400, 'Ugyldig forespørsel');
      c.messages.push({ role: 'user', content: input.content, at: now(), ...(input.files.length ? { files: input.files } : {}) });
    }
    const first = c.messages.filter(m => m.role === 'user').length === 1 && !input.chatId;
    await this.store.save(c);
    yield { type: 'chat', chat: { id: c.id, title: c.title } };

    const answer: ChatMessage = { role: 'assistant', content: '', at: now(), model: c.settings.model };
    const body: Raw = { model: c.settings.model, messages: await this.payloadMessages(api, c, system) };
    const files = this.payloadFiles(c);
    if (files.length) body.files = files;
    if (c.settings.toolIds.length) body.tool_ids = c.settings.toolIds;
    const f = c.settings.features;
    if (f.webSearch || f.codeInterpreter || f.imageGeneration) body.features = { web_search: f.webSearch, code_interpreter: f.codeInterpreter, image_generation: f.imageGeneration };
    try {
      const r = await api.stream(body, signal);
      if (/application\/json/.test(r.headers.get('content-type') ?? '')) {
        // Some pipes answer in one piece even when asked to stream
        const j = await r.json() as { choices?: { message?: { content?: string } }[]; sources?: unknown };
        answer.content = j.choices?.[0]?.message?.content ?? '';
        if (answer.content) yield { type: 'delta', text: answer.content };
      } else if (r.body) {
        for await (const e of readStream(r.body)) {
          if (e.type === 'delta') { answer.content += e.text; yield e; }
          else if (e.type === 'sources') { answer.sources = [...(answer.sources ?? []), ...e.sources]; yield e; }
          else if (e.type === 'error') { answer.error = e.message; yield e; }
          else if (e.type === 'done') break;
        }
      }
    } catch (e) {
      if (signal.aborted) answer.incomplete = true;
      else {
        answer.error = e instanceof OpenWebUiError ? `OpenWebUI: ${e.message}` : (e as Error).message;
        answer.incomplete = true;
        yield { type: 'error', message: answer.error };
      }
    }
    if (signal.aborted) answer.incomplete = true;
    c.messages.push(answer);
    if (first && answer.content && !signal.aborted) c.title = await this.title(api, c).catch(() => c.title) || c.title;
    await this.store.save(c);
    yield { type: 'done', message: answer, title: c.title };
  }

  /** A short title from OpenWebUI's own title task; the first words of the question when that does not work */
  private async title(api: OpenWebUiClient, c: Chat): Promise<string> {
    const r = await api.json<Raw>('POST', '/api/v1/tasks/title/completions', { model: c.settings.model, messages: c.messages.map(m => ({ role: m.role, content: m.content })) }, 20_000);
    const text = str((r.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content).trim();
    if (!text) return c.title;
    // Newer versions answer {"title": "..."}; older ones the title as plain text
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    let t = text;
    if (json) { try { t = str((JSON.parse(json) as Raw).title) || text; } catch { /* plain text */ } }
    return t.replace(/^["'#\s]+|["'\s]+$/g, '').slice(0, 80) || c.title;
  }
}
