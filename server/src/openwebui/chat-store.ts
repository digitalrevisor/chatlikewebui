// The conversations, one JSON file each under DATA_DIR/chats/<OpenWebUI user id>/. Only the owner can read them.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Source } from './client.js';

export interface ChatFile { id: string; name: string; type: 'file' | 'collection'; size?: number; /** Set for images, which go to the model inline */ mime?: string }
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** The model or agent that answered */
  model?: string;
  files?: ChatFile[];
  sources?: Source[];
  /** The answer stopped before the end (stopped by the person, or an error) */
  incomplete?: boolean;
  error?: string;
}
export interface ChatSettings {
  model: string;
  toolIds: string[];
  knowledgeIds: string[];
  features: { webSearch: boolean; codeInterpreter: boolean; imageGeneration: boolean };
  /** Extra instructions for this conversation only */
  system?: string;
}
/** Where a conversation belongs: the KI-chat page (none), a risk page, a workpaper, or a bank transaction */
export type ChatContext =
  | { kind: 'page'; document: string; page: string; title?: string }
  | { kind: 'workpaper'; document: string; page: string; title?: string }
  | { kind: 'bank'; document: string; transaction: string; title?: string };
/** One key per place, so each risk page, workpaper and transaction has its own conversations */
export const contextKey = (c?: ChatContext | null) => (!c ? '' : c.kind === 'bank' ? `bank:${c.document}:${c.transaction}` : `${c.kind}:${c.document}:${c.page}`);
export interface Chat { context?: ChatContext; id: string; userId: string; title: string; pinned: boolean; createdAt: string; updatedAt: string; settings: ChatSettings; messages: ChatMessage[] }
export type ChatSummary = Pick<Chat, 'id' | 'title' | 'pinned' | 'createdAt' | 'updatedAt'> & { model: string; context: string };

const ID = /^[0-9a-f-]{36}$/;
export const isChatId = (id: string) => ID.test(id);

export class ChatStore {
  constructor(private readonly root: string) {}

  private dir(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId)) throw new Error('bad user id');
    return join(this.root, userId);
  }
  private file(userId: string, id: string) {
    if (!isChatId(id)) throw new Error('bad chat id');
    return join(this.dir(userId), `${id}.json`);
  }

  /** The person's conversations in one place ('' is the KI-chat page itself) */
  async list(userId: string, context = ''): Promise<ChatSummary[]> {
    let names: string[];
    try { names = await readdir(this.dir(userId)); } catch { return []; }
    const chats = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.get(userId, n.slice(0, -5)).catch(() => null)));
    return chats.filter((c): c is Chat => !!c && contextKey(c.context) === context)
      .map(c => ({ id: c.id, title: c.title, pinned: c.pinned, createdAt: c.createdAt, updatedAt: c.updatedAt, model: c.settings.model, context }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(userId: string, id: string): Promise<Chat | null> {
    if (!isChatId(id)) return null;
    try {
      const c = JSON.parse(await readFile(this.file(userId, id), 'utf8')) as Chat;
      return c.userId === userId ? c : null;
    } catch { return null; }
  }

  create(userId: string, settings: ChatSettings, title = '', context?: ChatContext): Chat {
    const now = new Date().toISOString();
    return { id: randomUUID(), userId, title, pinned: false, createdAt: now, updatedAt: now, settings, messages: [], ...(context ? { context } : {}) };
  }

  /** Writes the whole conversation (through a temporary file, so a crash never leaves half a file) */
  async save(c: Chat, touch = true) {
    if (touch) c.updatedAt = new Date().toISOString();
    await mkdir(this.dir(c.userId), { recursive: true });
    const path = this.file(c.userId, c.id);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(c));
    await rename(tmp, path);
    return c;
  }

  async remove(userId: string, id: string) {
    await rm(this.file(userId, id), { force: true });
  }
}
