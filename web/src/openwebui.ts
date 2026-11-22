// The chat's calls: what the instance offers, conversations, uploads and the streamed answer.
import { errorOf } from './api';

export interface Model { id: string; name: string; description: string; image: string | null; agent: boolean; baseModelId: string | null; ownedBy: string; knowledgeIds: string[]; toolIds: string[]; suggestions: string[]; tags: string[] }
export interface Knowledge { id: string; name: string; description: string; files: { id: string; name: string; size: number | null }[]; updatedAt: string | null }
export interface Tool { id: string; name: string; description: string }
export interface Fn { id: string; name: string; type: string; active: boolean; global: boolean; description: string }
export interface Prompt { command: string; title: string; content: string }
export interface Catalog { models: Model[]; knowledge: Knowledge[]; tools: Tool[]; functions: Fn[]; prompts: Prompt[] }
export interface Status { reachable: boolean; version: string | null; url: string | null; error?: string }

export interface ChatFile { id: string; name: string; type: 'file' | 'collection'; size?: number; mime?: string }
export interface Source { name: string; url?: string; snippet?: string }
export interface Message { role: 'user' | 'assistant'; content: string; at: string; model?: string; files?: ChatFile[]; sources?: Source[]; incomplete?: boolean; error?: string }
export interface Features { webSearch: boolean; codeInterpreter: boolean; imageGeneration: boolean }
export interface Settings { model: string; toolIds: string[]; knowledgeIds: string[]; features: Features; system?: string }
export interface Chat { id: string; title: string; pinned: boolean; createdAt: string; updatedAt: string; settings: Settings; messages: Message[] }
export interface ChatSummary { id: string; title: string; pinned: boolean; createdAt: string; updatedAt: string; model: string }

export type StreamEvent =
  | { type: 'chat'; chat: { id: string; title: string } }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'error'; message: string }
  | { type: 'done'; message: Message; title: string };

export const BASE = '/api/owui';

/** Uploads files to OpenWebUI through the app */
export async function uploadFiles(path: string, files: File[]) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const r = await fetch(`${BASE}${path}`, { method: 'POST', body: form, credentials: 'same-origin' });
  if (!r.ok) throw await errorOf(r);
  return r.json();
}

/** Posts the message and calls onEvent for every event of the answer, until it ends or `signal` stops it */
export async function streamReply(body: { chatId?: string; content: string; files: ChatFile[]; settings: Settings; editIndex?: number; regenerate?: boolean }, onEvent: (e: StreamEvent) => void, signal: AbortSignal) {
  const r = await fetch(`${BASE}/chats/stream`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) throw await errorOf(r);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block: string) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { onEvent(JSON.parse(line.slice(5)) as StreamEvent); } catch { /* a broken line is skipped */ }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, end)); buf = buf.slice(end + 2); }
    }
    flush(buf + decoder.decode());
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
}
