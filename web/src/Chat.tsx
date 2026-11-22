// The chat (/, /c/:id): a ChatGPT-like page on Digital Revisor's OpenWebUI. Conversations on the left;
// a model or agent, knowledge, tools and features (web search, code interpreter, image generation) for each conversation;
// answers stream in word by word and can be stopped, answered again, or the question edited. Admins add agents
// (a base model with instructions, knowledge and tools) and knowledge bases.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, DialogFooter, ErrorBox, Field, Icon, Input, Menu, Spinner, Textarea, safeHtml, useAct, useFeedback, useT, usePageTitle } from './ui';
import { marked } from 'marked';
import { del, get, patch, post, type Me } from './api';
import { BASE, streamReply, uploadFiles, type Catalog, type Chat, type ChatFile, type ChatSummary, type Features, type Knowledge, type Message, type Model, type Settings, type Status } from './openwebui';

/** Answers are Markdown: tables, code and pictures are kept, everything else is cleaned */
export const markdown = (text: string) => safeHtml(marked.parse(text, { async: false }) as string);
export const NO_FEATURES: Features = { webSearch: false, codeInterpreter: false, imageGeneration: false };
const MODEL_KEY = 'owui-model';
export const size = (n?: number) => (!n ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const remembered = () => { try { return localStorage.getItem(MODEL_KEY) ?? ''; } catch { return ''; } };
export const remember = (id: string) => { try { localStorage.setItem(MODEL_KEY, id); } catch { /* only a convenience */ } };

/** Conversations by when they were last used, pinned ones first */
function groups(chats: ChatSummary[], t: (k: string) => string) {
  const day = 86_400_000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: { label: string; chats: ChatSummary[] }[] = [];
  const add = (label: string, c: ChatSummary) => { const g = out.find(x => x.label === label); if (g) g.chats.push(c); else out.push({ label, chats: [c] }); };
  for (const c of chats) {
    const at = new Date(c.updatedAt).getTime();
    add(c.pinned ? t('chat.pinned') : at >= today.getTime() ? t('chat.today') : at >= today.getTime() - day ? t('chat.yesterday') : at >= today.getTime() - 7 * day ? t('chat.last7days') : at >= today.getTime() - 30 * day ? t('chat.last30days') : t('chat.older'), c);
  }
  return out;
}

/** A small popover that closes on a click outside or Escape */
function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-popover-trigger]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open, onClose]);
  return open ? <div ref={ref} className={`app-owc-pop ${className ?? ''}`}>{children}</div> : null;
}

/** The model and agent picker: agents first, a search box when there are many */
export function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = models.find(m => m.id === value);
  const match = (m: Model) => !q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q.toLowerCase());
  const section = (label: string, list: Model[]) => list.length > 0 && (
    <>
      <div className="app-owc-pop-head">{label}</div>
      {list.map(m => (
        <button key={m.id} type="button" className={`app-owc-pop-item${m.id === value ? ' is-on' : ''}`} onClick={() => { onChange(m.id); setOpen(false); setQ(''); }}>
          <span className="app-owc-model-icon"><Icon name={m.agent ? 'user-circle-fill' : 'spark-fill'} /></span>
          <span className="min-w-0 flex-grow-1"><span className="d-block text-truncate fw-medium">{m.name}</span>{(m.description || m.baseModelId) && <span className="d-block small text-soft text-truncate">{m.description || m.baseModelId}</span>}</span>
          {m.id === value && <Icon name="check" />}
        </button>
      ))}
    </>
  );
  return (
    <div className="position-relative">
      <button type="button" data-popover-trigger className="app-owc-model" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={current?.agent ? 'user-circle-fill' : 'spark-fill'} /><span className="text-truncate">{current?.name ?? (value || t('chat.choosemodel'))}</span><Icon name="chevron-down" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="app-owc-pop-models">
        {models.length > 6 && <input autoFocus className="form-control form-control-sm mb-2" placeholder={t('chat.searchmodels')} value={q} onChange={e => setQ(e.target.value)} />}
        {section(t('chat.agents'), models.filter(m => m.agent && match(m)))}
        {section(t('chat.models'), models.filter(m => !m.agent && match(m)))}
        {!models.some(match) && <div className="p-2 small text-soft">{t('chat.nomodels')}</div>}
      </Popover>
    </div>
  );
}

/** Chooses several of a list (knowledge, tools) */
export function MultiPicker({ icon, label, items, value, onChange, empty }: { icon: string; label: string; items: { id: string; name: string; description?: string }[]; value: string[]; onChange: (v: string[]) => void; empty: string }) {
  const [open, setOpen] = useState(false);
  const n = value.filter(id => items.some(i => i.id === id)).length;
  return (
    <div className="position-relative">
      <button type="button" data-popover-trigger className={`app-owc-chip${n ? ' is-on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title={label}>
        <Icon name={icon} /><span>{label}{n ? ` · ${n}` : ''}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="app-owc-pop-up">
        <div className="app-owc-pop-head">{label}</div>
        {items.length === 0 ? <div className="p-2 small text-soft">{empty}</div> : items.map(i => {
          const on = value.includes(i.id);
          return (
            <label key={i.id} className={`app-owc-pop-item${on ? ' is-on' : ''}`}>
              <input type="checkbox" className="form-check-input mt-0" checked={on} onChange={() => onChange(on ? value.filter(x => x !== i.id) : [...value, i.id])} />
              <span className="min-w-0 flex-grow-1"><span className="d-block text-truncate">{i.name}</span>{i.description && <span className="d-block small text-soft text-truncate">{i.description}</span>}</span>
            </label>
          );
        })}
      </Popover>
    </div>
  );
}

export function MessageView({ m, models, last, busy, onEdit, onRegenerate, extra }: { m: Message; models: Model[]; last: boolean; busy: boolean; onEdit?: () => void; onRegenerate?: () => void; extra?: ReactNode }) {
  const t = useT();
  const { toast } = useFeedback();
  const copy = async () => { try { await navigator.clipboard.writeText(m.content); toast('success', t('pages.copiedtoclipboard')); } catch { /* the text stays on the page */ } };
  if (m.role === 'user') return (
    <div className="app-owc-user">
      <div className="app-owc-user-bubble">
        {m.content}
        {m.files && m.files.length > 0 && <span className="app-owc-user-files">{m.files.map(f => <span key={f.id}><Icon name={f.mime ? 'img' : 'file'} /> {f.name}</span>)}</span>}
      </div>
      {onEdit && !busy && <button type="button" className="app-owc-icon-btn" title={t('chat.edit')} aria-label={t('chat.edit')} onClick={onEdit}><Icon name="edit" /></button>}
    </div>
  );
  const name = models.find(x => x.id === m.model)?.name ?? m.model;
  const typing = busy && last && !m.content && !m.error;
  return (
    <div className="app-owc-ai">
      <span className="app-owc-avatar"><Icon name="spark-fill" /></span>
      <div className="app-owc-ai-body">
        {name && <div className="app-owc-ai-meta">{name}</div>}
        {typing ? <span className="app-aic-dots" role="status" aria-label={t('pages.aithinking')}><i /><i /><i /></span>
          : <div className="app-markdown" dangerouslySetInnerHTML={{ __html: markdown(m.content) }} />}
        {m.error && <div className="alert alert-danger py-2 px-3 mt-2 mb-0 small">{m.error}</div>}
        {m.incomplete && !m.error && !busy && <div className="small text-soft mt-1">{t('chat.stopped')}</div>}
        {m.sources && m.sources.length > 0 && (
          <div className="app-owc-sources">
            {m.sources.map((s, i) => s.url
              ? <a key={i} href={s.url} target="_blank" rel="noreferrer" className="app-owc-source" title={s.snippet}><Icon name="link" />{s.name}</a>
              : <span key={i} className="app-owc-source" title={s.snippet}><Icon name="file-text" />{s.name}</span>)}
          </div>
        )}
        {!(busy && last) && m.content && (
          <div className="app-owc-ai-actions">
            <button type="button" className="app-owc-icon-btn" title={t('pages.copytext')} aria-label={t('pages.copytext')} onClick={() => void copy()}><Icon name="copy" /></button>
            {last && onRegenerate && <button type="button" className="app-owc-icon-btn" title={t('chat.regenerate')} aria-label={t('chat.regenerate')} onClick={onRegenerate}><Icon name="regen" /></button>}
            {extra}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPage({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const t = useT();
  usePageTitle(t('chat.title'));
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const act = useAct();
  const { toast, confirm } = useFeedback();
  const admin = me.role === 'admin';
  const status = useQuery({ queryKey: ['owui-status'], queryFn: () => get<Status>(`${BASE}/status`), staleTime: 60_000 });
  const catalog = useQuery({ queryKey: ['owui-catalog'], queryFn: () => get<Catalog>(`${BASE}/catalog`), staleTime: 60_000 });
  const chats = useQuery({ queryKey: ['owui-chats'], queryFn: () => get<ChatSummary[]>(`${BASE}/chats`) });
  const models = useMemo(() => catalog.data?.models ?? [], [catalog.data]);

  const [chat, setChat] = useState<Chat | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [settings, setSettings] = useState<Settings>({ model: remembered(), toolIds: [], knowledgeIds: [], features: NO_FEATURES });
  const [text, setText] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [sideOpen, setSideOpen] = useState(false);
  const [dialog, setDialog] = useState<'agent' | 'knowledge' | 'system' | 'functions' | null>(null);
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const stop = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // The chosen model must exist; the first agent (or model) otherwise
  useEffect(() => {
    if (!models.length || models.some(m => m.id === settings.model)) return;
    setSettings(s => ({ ...s, model: (models.find(m => m.agent) ?? models[0])!.id }));
  }, [models, settings.model]);

  // Opening a conversation from the address (not the one just made while streaming)
  useEffect(() => {
    if (!routeId) { if (!busy) { setChat(null); setEditing(null); } return; }
    if (chat?.id === routeId) return;
    setLoadingChat(true);
    get<Chat>(`${BASE}/chats/${routeId}`).then(c => { setChat(c); setSettings({ ...c.settings, features: c.settings.features ?? NO_FEATURES }); setEditing(null); })
      .catch(() => { toast('error', t('chat.notfound')); navigate('/', { replace: true }); })
      .finally(() => setLoadingChat(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [chat?.messages.length, chat?.messages.at(-1)?.content.length, busy]);

  const model = models.find(m => m.id === settings.model);
  const setModel = (id: string) => {
    remember(id);
    const m = models.find(x => x.id === id);
    // An agent brings its own knowledge and tools; they are not chosen twice
    setSettings(s => ({ ...s, model: id, knowledgeIds: s.knowledgeIds.filter(k => !m?.knowledgeIds.includes(k)), toolIds: s.toolIds.filter(k => !m?.toolIds.includes(k)) }));
    if (chat) void patch(`${BASE}/chats/${chat.id}`, { settings: { model: id } }).catch(() => undefined);
  };

  const newChat = () => { stop.current?.abort(); setChat(null); setText(''); setFiles([]); setEditing(null); setSettings(s => ({ ...s, system: undefined })); navigate('/'); setSideOpen(false); requestAnimationFrame(() => box.current?.focus()); };

  const attach = async (list: File[]) => {
    if (!list.length) return;
    setUploading(n => n + list.length);
    try { const up = await uploadFiles('/files', list) as ChatFile[]; setFiles(f => [...f, ...up]); }
    catch (e) { toast('error', t((e as Error).message)); }
    finally { setUploading(n => n - list.length); }
  };

  /** Sends (or edits, or answers again) and fills in the answer as it streams */
  const send = async (opts: { regenerate?: boolean } = {}) => {
    const content = text.trim();
    if (busy || uploading || !settings.model || (!opts.regenerate && !content && !files.length)) return;
    const sent = files;
    const editIndex = editing ?? undefined;
    const base: Message[] = chat?.messages ?? [];
    const kept = opts.regenerate ? base.slice(0, base.map(m => m.role).lastIndexOf('user') + 1) : editIndex !== undefined ? base.slice(0, editIndex) : base;
    const userMsg: Message[] = opts.regenerate ? [] : [{ role: 'user', content, at: new Date().toISOString(), files: sent.length ? sent : undefined }];
    const placeholder: Message = { role: 'assistant', content: '', at: new Date().toISOString(), model: settings.model };
    setChat(c => ({ ...(c ?? { id: '', title: '', pinned: false, createdAt: '', updatedAt: '', settings }), settings, messages: [...kept, ...userMsg, placeholder] }));
    if (!opts.regenerate) { setText(''); setFiles([]); }
    setEditing(null);
    setBusy(true);
    const ctrl = new AbortController();
    stop.current = ctrl;
    const patchLast = (f: (m: Message) => Message) => setChat(c => (c ? { ...c, messages: [...c.messages.slice(0, -1), f(c.messages.at(-1)!)] } : c));
    try {
      await streamReply({ chatId: chat?.id || undefined, content, files: sent, settings, editIndex, regenerate: opts.regenerate }, e => {
        if (e.type === 'chat') {
          setChat(c => (c ? { ...c, id: e.chat.id, title: e.chat.title } : c));
          if (!chat?.id) navigate(`/c/${e.chat.id}`, { replace: true });
          void qc.invalidateQueries({ queryKey: ['owui-chats'] });
        } else if (e.type === 'delta') patchLast(m => ({ ...m, content: m.content + e.text }));
        else if (e.type === 'sources') patchLast(m => ({ ...m, sources: [...(m.sources ?? []), ...e.sources] }));
        else if (e.type === 'error') patchLast(m => ({ ...m, error: e.message }));
        else if (e.type === 'done') { patchLast(() => e.message); setChat(c => (c ? { ...c, title: e.title } : c)); }
      }, ctrl.signal);
    } catch (e) {
      patchLast(m => ({ ...m, error: t((e as Error).message), incomplete: true }));
      if (!opts.regenerate && !chat?.id) { setText(content); setFiles(sent); }
    } finally {
      if (ctrl.signal.aborted) patchLast(m => ({ ...m, incomplete: true }));
      setBusy(false);
      stop.current = null;
      void qc.invalidateQueries({ queryKey: ['owui-chats'] });
    }
  };

  const startEdit = (i: number) => { const m = chat?.messages[i]; if (!m) return; setEditing(i); setText(m.content); setFiles(m.files ?? []); requestAnimationFrame(() => box.current?.focus()); };
  const removeChat = async (c: ChatSummary) => {
    if (!(await confirm({ title: t('chat.deleteconfirm'), action: t('pages.delete') }))) return;
    if (await act(() => del(`${BASE}/chats/${c.id}`), { invalidate: [['owui-chats']] }) && c.id === chat?.id) newChat();
  };
  const pin = (c: ChatSummary) => act(() => patch(`${BASE}/chats/${c.id}`, { pinned: !c.pinned }), { invalidate: [['owui-chats']] });

  // "/" opens the prompt library: /command fills in the prompt
  const prompts = catalog.data?.prompts ?? [];
  const slash = /^\/(\S*)$/.exec(text)?.[1];
  const promptMatches = slash !== undefined ? prompts.filter(p => p.command.toLowerCase().startsWith(slash.toLowerCase()) || p.title.toLowerCase().includes(slash.toLowerCase())).slice(0, 8) : [];
  const usePrompt = (content: string) => { setText(content); requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(content.length, content.length); }); };

  const list = (chats.data ?? []).filter(c => !search || c.title.toLowerCase().includes(search.toLowerCase()));
  const messages = chat?.messages ?? [];
  const lastUser = messages.map(m => m.role).lastIndexOf('user');
  const knowledge = (catalog.data?.knowledge ?? []).filter(k => !model?.knowledgeIds.includes(k.id));
  const tools = (catalog.data?.tools ?? []).filter(x => !model?.toolIds.includes(x.id));
  const feature = (k: keyof Features, icon: string, label: string) => (
    <button type="button" className={`app-owc-chip${settings.features[k] ? ' is-on' : ''}`} aria-pressed={settings.features[k]} title={label}
      onClick={() => setSettings(s => ({ ...s, features: { ...s.features, [k]: !s.features[k] } }))}><Icon name={icon} /><span>{label}</span></button>
  );

  if (status.isPending) return <Spinner />;
  if (status.error) return <ErrorBox error={status.error} />;
  return (
    <div className={`app-owc${sideOpen ? ' is-side-open' : ''}`}>
      <aside className="app-owc-side">
        <Button variant="primary" icon="plus" className="w-100 mb-2" onClick={newChat}>{t('chat.newchat')}</Button>
        <input className="form-control form-control-sm mb-2" type="search" placeholder={t('chat.searchchats')} value={search} onChange={e => setSearch(e.target.value)} />
        <nav className="app-owc-list" aria-label={t('chat.conversations')}>
          {chats.isPending ? <Spinner /> : list.length === 0 ? <p className="small text-soft p-2">{t('chat.nochats')}</p> : groups(list, t).map(g => (
            <div key={g.label}>
              <div className="app-owc-list-head">{g.label}</div>
              {g.chats.map(c => (
                <div key={c.id} className={`app-owc-list-item${c.id === chat?.id ? ' is-on' : ''}`}>
                  <button type="button" className="app-owc-list-link" onClick={() => { navigate(`/c/${c.id}`); setSideOpen(false); }}>{c.pinned && <Icon name="bookmark-fill" />}<span className="text-truncate">{c.title || t('chat.untitled')}</span></button>
                  <Menu trigger={<button type="button" className="app-owc-icon-btn" aria-label={t('chat.actions')}><Icon name="more-h" /></button>} items={[
                    { label: t('chat.rename'), icon: 'edit', onSelect: () => setRenaming(c) },
                    { label: c.pinned ? t('chat.unpin') : t('chat.pin'), icon: 'bookmark', onSelect: () => void pin(c) },
                    { label: t('pages.delete'), icon: 'trash', danger: true, divider: true, onSelect: () => void removeChat(c) },
                  ]} />
                </div>
              ))}
            </div>
          ))}
        </nav>
        {admin && (
          <div className="app-owc-side-admin">
            <button type="button" onClick={() => setDialog('agent')}><Icon name="user-add" />{t('chat.newagent')}</button>
            <button type="button" onClick={() => setDialog('knowledge')}><Icon name="book" />{t('chat.knowledge')}</button>
            <button type="button" onClick={() => setDialog('functions')}><Icon name="setting" />{t('chat.functions')}</button>
          </div>
        )}
        <div className="app-owc-me">
          <span className="app-owc-me-avatar" aria-hidden="true">{(me.name || me.email || '?').slice(0, 1).toUpperCase()}</span>
          <span className="flex-grow-1 min-w-0"><span className="d-block text-truncate fw-semibold">{me.name || me.email}</span>{me.name && me.email && <span className="d-block small text-soft text-truncate">{me.email}</span>}</span>
          <button type="button" className="app-owc-icon-btn" title={t('login.logout')} aria-label={t('login.logout')} onClick={onLogout}><Icon name="logout" /></button>
        </div>
      </aside>
      {sideOpen && <button type="button" className="app-owc-scrim" aria-label={t('pages.close')} onClick={() => setSideOpen(false)} />}

      <section className="app-owc-main">
        <header className="app-owc-head">
          <button type="button" className="app-owc-icon-btn d-lg-none" aria-label={t('chat.conversations')} onClick={() => setSideOpen(true)}><Icon name="menu" /></button>
          {catalog.isPending ? <Spinner /> : <ModelPicker models={models} value={settings.model} onChange={setModel} />}
          <span className="flex-grow-1" />
          {!status.data.reachable && <Badge tone="red">{t('chat.unreachable')}</Badge>}
          <button type="button" className={`app-owc-icon-btn${settings.system ? ' is-on' : ''}`} title={t('chat.instructions')} aria-label={t('chat.instructions')} onClick={() => setDialog('system')}><Icon name="setting-alt" /></button>
          <button type="button" className="app-owc-icon-btn" title={t('chat.newchat')} aria-label={t('chat.newchat')} onClick={newChat}><Icon name="edit-alt" /></button>
        </header>
        {catalog.error && <div className="px-3"><ErrorBox error={catalog.error} /></div>}

        <div className="app-owc-thread">
          {loadingChat ? <Spinner /> : messages.length === 0 ? (
            <div className="app-owc-hero">
              <span className="app-owc-hero-icon"><Icon name={model?.agent ? 'user-circle-fill' : 'spark-fill'} /></span>
              <h2>{model?.name ?? t('chat.title')}</h2>
              <p className="text-soft">{model?.description || t('chat.hero')}</p>
              {model && model.suggestions.length > 0 && (
                <div className="app-owc-suggestions">
                  {model.suggestions.slice(0, 4).map((s, i) => <button key={i} type="button" onClick={() => usePrompt(s)}>{s}</button>)}
                </div>
              )}
            </div>
          ) : (
            <div className="app-owc-messages">
              {messages.map((m, i) => (
                <MessageView key={i} m={m} models={models} busy={busy} last={i === messages.length - 1}
                  onEdit={m.role === 'user' && i === lastUser ? () => startEdit(i) : undefined}
                  onRegenerate={m.role === 'assistant' ? () => void send({ regenerate: true }) : undefined} />
              ))}
              <div ref={end} />
            </div>
          )}
        </div>

        <form className="app-owc-composer" onSubmit={e => { e.preventDefault(); void send(); }}
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void attach([...e.dataTransfer.files]); }}>
          {promptMatches.length > 0 && (
            <div className="app-owc-pop app-owc-pop-prompts">
              <div className="app-owc-pop-head">{t('chat.prompts')}</div>
              {promptMatches.map(p => <button key={p.command} type="button" className="app-owc-pop-item" onClick={() => usePrompt(p.content)}><strong>/{p.command}</strong><span className="text-soft text-truncate">{p.title}</span></button>)}
            </div>
          )}
          {editing !== null && <div className="app-owc-editing"><Icon name="edit" />{t('chat.editing')}<button type="button" onClick={() => { setEditing(null); setText(''); setFiles([]); }}>{t('pages.cancel')}</button></div>}
          {(files.length > 0 || uploading > 0) && (
            <div className="app-aic-files">
              {files.map(f => (
                <span key={f.id} className="app-aic-file"><Icon name={f.mime ? 'img' : 'file'} />{f.name}<small>{size(f.size)}</small>
                  <button type="button" aria-label={`${t('pages.removefile')}: ${f.name}`} onClick={() => setFiles(files.filter(x => x.id !== f.id))}><Icon name="cross" /></button>
                </span>
              ))}
              {uploading > 0 && <span className="app-aic-file"><span className="spinner-border spinner-border-sm" aria-hidden="true" />{t('chat.uploading')}</span>}
            </div>
          )}
          <textarea ref={box} className="app-owc-input" rows={1} aria-label={t('pages.message')} placeholder={t('chat.placeholder')} value={text}
            onChange={e => setText(e.target.value)}
            onPaste={e => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); void attach(f); } }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (promptMatches.length) usePrompt(promptMatches[0]!.content); else void send();
              }
            }} />
          <div className="app-owc-bar">
            <input ref={fileInput} type="file" multiple hidden onChange={e => { void attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <button type="button" className="app-owc-round" title={t('pages.attachments')} aria-label={t('pages.attachments')} onClick={() => fileInput.current?.click()}><Icon name="clip" /></button>
            <MultiPicker icon="book" label={t('chat.knowledge')} items={knowledge} value={settings.knowledgeIds} onChange={v => setSettings(s => ({ ...s, knowledgeIds: v }))} empty={t('chat.noknowledge')} />
            <MultiPicker icon="setting-fill" label={t('chat.tools')} items={tools} value={settings.toolIds} onChange={v => setSettings(s => ({ ...s, toolIds: v }))} empty={t('chat.notools')} />
            {feature('webSearch', 'globe', t('chat.websearch'))}
            {feature('codeInterpreter', 'code', t('chat.codeinterpreter'))}
            {feature('imageGeneration', 'img', t('chat.imagegeneration'))}
            <span className="flex-grow-1" />
            {busy
              ? <button type="button" className="app-owc-send" title={t('chat.stop')} aria-label={t('chat.stop')} onClick={() => stop.current?.abort()}><Icon name="stop-fill" /></button>
              : <button type="submit" className="app-owc-send" title={t('pages.send')} aria-label={t('pages.send')} disabled={!!uploading || !settings.model || (!text.trim() && !files.length)}><Icon name="arrow-up" /></button>}
          </div>
        </form>
        <p className="app-owc-foot">{t('chat.disclaimer')}</p>
      </section>

      {renaming && <RenameDialog chat={renaming} onClose={() => setRenaming(null)} onSaved={title => { if (chat?.id === renaming.id) setChat({ ...chat, title }); }} />}
      {dialog === 'system' && <SystemDialog value={settings.system ?? ''} onClose={() => setDialog(null)} onSave={v => {
        setSettings(s => ({ ...s, system: v || undefined }));
        if (chat?.id) void patch(`${BASE}/chats/${chat.id}`, { settings: { system: v } }).catch(() => undefined);
        setDialog(null);
      }} />}
      {dialog === 'agent' && catalog.data && <AgentDialog catalog={catalog.data} onClose={() => setDialog(null)} onCreated={m => { setModel(m.id); setDialog(null); }} />}
      {dialog === 'knowledge' && <KnowledgeDialog knowledge={catalog.data?.knowledge ?? []} onClose={() => setDialog(null)} />}
      {dialog === 'functions' && catalog.data && <FunctionsDialog catalog={catalog.data} status={status.data} onClose={() => setDialog(null)} />}
    </div>
  );
}

function RenameDialog({ chat, onClose, onSaved }: { chat: ChatSummary; onClose: () => void; onSaved: (title: string) => void }) {
  const t = useT();
  const act = useAct();
  const [title, setTitle] = useState(chat.title);
  const save = async () => { if (await act(() => patch(`${BASE}/chats/${chat.id}`, { title }), { invalidate: [['owui-chats']] })) { onSaved(title); onClose(); } };
  return (
    <Dialog open onClose={onClose} title={t('chat.rename')}>
      <form onSubmit={e => { e.preventDefault(); void save(); }} className="d-flex flex-column gap-3">
        <Field label={t('pages.title')}><Input autoFocus maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></Field>
        <DialogFooter submit={t('pages.save')} disabled={!title.trim()} onSubmit={() => void save()} />
      </form>
    </Dialog>
  );
}

function SystemDialog({ value, onClose, onSave }: { value: string; onClose: () => void; onSave: (v: string) => void }) {
  const t = useT();
  const [v, setV] = useState(value);
  return (
    <Dialog open onClose={onClose} size="lg" title={t('chat.instructions')}>
      <form onSubmit={e => { e.preventDefault(); onSave(v.trim()); }} className="d-flex flex-column gap-3">
        <Field label={t('chat.instructions')} hint={t('chat.instructionshint')}><Textarea rows={8} value={v} onChange={e => setV(e.target.value)} /></Field>
        <DialogFooter submit={t('pages.save')} onSubmit={() => onSave(v.trim())} />
      </form>
    </Dialog>
  );
}

/** A new agent: an OpenWebUI custom model with a base model, instructions, knowledge, tools and suggested questions */
function AgentDialog({ catalog, onClose, onCreated }: { catalog: Catalog; onClose: () => void; onCreated: (m: Model) => void }) {
  const t = useT();
  const act = useAct();
  const { confirm } = useFeedback();
  const bases = catalog.models.filter(m => !m.agent);
  const [v, setV] = useState({ name: '', baseModelId: bases[0]?.id ?? '', description: '', system: '', suggestions: '' });
  const [knowledgeIds, setKnowledge] = useState<string[]>([]);
  const [toolIds, setTools] = useState<string[]>([]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const save = async () => {
    let created: Model | null = null;
    const ok = await act(async () => { created = await post<Model>(`${BASE}/agents`, { ...v, suggestions: v.suggestions.split('\n').map(s => s.trim()).filter(Boolean), knowledgeIds, toolIds }); }, { success: t('chat.agentcreated'), invalidate: [['owui-catalog']] });
    if (ok && created) onCreated(created);
  };
  const remove = async (m: Model) => {
    if (await confirm({ title: `${t('chat.deleteagent')}: ${m.name}?`, action: t('pages.delete') })) await act(() => del(`${BASE}/agents/${encodeURIComponent(m.id)}`), { success: t('chat.agentdeleted'), invalidate: [['owui-catalog']] });
  };
  const agents = catalog.models.filter(m => m.agent);
  return (
    <Dialog open onClose={onClose} size="xl" title={t('chat.agents')}>
      {agents.length > 0 && (
        <ul className="app-owc-admin-list mb-3">
          {agents.map(m => (
            <li key={m.id}><Icon name="user-circle-fill" /><span className="flex-grow-1 min-w-0"><strong>{m.name}</strong><span className="d-block small text-soft text-truncate">{[m.baseModelId, m.description].filter(Boolean).join(' · ')}</span></span>
              <Button size="sm" variant="ghost" icon="trash" aria-label={t('pages.delete')} title={t('pages.delete')} onClick={() => void remove(m)} /></li>
          ))}
        </ul>
      )}
      <form className="app-grid-2 border-top pt-3" onSubmit={e => { e.preventDefault(); void save(); }}>
        <h6 className="app-span-all mb-0">{t('chat.newagent')}</h6>
        <Field label={t('pages.name')}><Input required maxLength={100} value={v.name} onChange={e => setV({ ...v, name: e.target.value })} placeholder={t('chat.agentnamehint')} /></Field>
        <Field label={t('chat.basemodel')}>
          <select className="form-select" value={v.baseModelId} onChange={e => setV({ ...v, baseModelId: e.target.value })}>{bases.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        </Field>
        <div className="app-span-all"><Field label={t('chat.description')}><Input maxLength={1000} value={v.description} onChange={e => setV({ ...v, description: e.target.value })} /></Field></div>
        <div className="app-span-all"><Field label={t('chat.instructions')} hint={t('chat.agentinstructionshint')}><Textarea rows={6} value={v.system} onChange={e => setV({ ...v, system: e.target.value })} /></Field></div>
        <Field label={t('chat.knowledge')}>
          <div className="app-owc-checks">{catalog.knowledge.length === 0 ? <span className="small text-soft">{t('chat.noknowledge')}</span> : catalog.knowledge.map(k => (
            <label key={k.id} className="form-check"><input type="checkbox" className="form-check-input" checked={knowledgeIds.includes(k.id)} onChange={() => toggle(knowledgeIds, setKnowledge, k.id)} /> <span className="form-check-label">{k.name}</span></label>
          ))}</div>
        </Field>
        <Field label={t('chat.tools')}>
          <div className="app-owc-checks">{catalog.tools.length === 0 ? <span className="small text-soft">{t('chat.notools')}</span> : catalog.tools.map(x => (
            <label key={x.id} className="form-check"><input type="checkbox" className="form-check-input" checked={toolIds.includes(x.id)} onChange={() => toggle(toolIds, setTools, x.id)} /> <span className="form-check-label">{x.name}</span></label>
          ))}</div>
        </Field>
        <div className="app-span-all"><Field label={t('chat.suggestions')} hint={t('chat.suggestionshint')}><Textarea rows={3} value={v.suggestions} onChange={e => setV({ ...v, suggestions: e.target.value })} /></Field></div>
        <div className="app-span-all"><DialogFooter submit={t('chat.createagent')} icon="user-add" disabled={!v.name.trim() || !v.baseModelId} onSubmit={() => void save()} /></div>
      </form>
    </Dialog>
  );
}

/** Knowledge bases: make one, add files to it, remove files, delete it (admins) */
function KnowledgeDialog({ knowledge, onClose }: { knowledge: Knowledge[]; onClose: () => void }) {
  const t = useT();
  const act = useAct();
  const qc = useQueryClient();
  const { confirm, toast } = useFeedback();
  const [open, setOpen] = useState<string | null>(knowledge[0]?.id ?? null);
  const [v, setV] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  const item = useQuery({ queryKey: ['owui-knowledge', open], queryFn: () => get<Knowledge>(`${BASE}/knowledge/${open}`), enabled: !!open });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['owui-catalog'] }), qc.invalidateQueries({ queryKey: ['owui-knowledge'] })]);
  const create = async () => {
    let made: Knowledge | null = null;
    if (await act(async () => { made = await post<Knowledge>(`${BASE}/knowledge`, v); }, { success: t('chat.knowledgecreated'), invalidate: [['owui-catalog']] }) && made) { setOpen((made as Knowledge).id); setV({ name: '', description: '' }); }
  };
  const add = async (files: File[]) => {
    if (!open || !files.length) return;
    setBusy(true);
    try { await uploadFiles(`/knowledge/${encodeURIComponent(open)}/files`, files); toast('success', t('chat.filesadded')); await refresh(); }
    catch (e) { toast('error', t((e as Error).message)); }
    finally { setBusy(false); }
  };
  const k = knowledge.find(x => x.id === open);
  return (
    <Dialog open onClose={onClose} size="xl" title={t('chat.knowledge')}>
      <div className="app-owc-knowledge">
        <div>
          <ul className="app-owc-admin-list">
            {knowledge.map(x => <li key={x.id} className={x.id === open ? 'is-on' : undefined}><button type="button" onClick={() => setOpen(x.id)}><Icon name="book" /><span className="text-truncate">{x.name}</span></button></li>)}
          </ul>
          <form className="d-flex flex-column gap-2 mt-3" onSubmit={e => { e.preventDefault(); void create(); }}>
            <Input placeholder={t('chat.knowledgename')} value={v.name} onChange={e => setV({ ...v, name: e.target.value })} />
            <Input placeholder={t('chat.description')} value={v.description} onChange={e => setV({ ...v, description: e.target.value })} />
            <Button type="submit" variant="primary" icon="plus" disabled={!v.name.trim()}>{t('chat.newknowledge')}</Button>
          </form>
        </div>
        <div>
          {!k ? <p className="text-soft">{t('chat.noknowledge')}</p> : (
            <>
              <div className="d-flex align-items-start gap-2 mb-2">
                <div className="flex-grow-1"><h6 className="mb-0">{k.name}</h6>{k.description && <span className="small text-soft">{k.description}</span>}</div>
                <label className={`btn btn-sm btn-primary${busy ? ' disabled' : ''}`}>{busy ? <span className="spinner-border spinner-border-sm" /> : <Icon name="upload" />}<span>{t('chat.addfiles')}</span>
                  <input type="file" multiple hidden disabled={busy} onChange={e => { void add([...(e.target.files ?? [])]); e.target.value = ''; }} /></label>
                <Button size="sm" variant="ghost" icon="trash" aria-label={t('pages.delete')} title={t('pages.delete')} onClick={() => void confirm({ title: `${t('chat.deleteknowledge')}: ${k.name}?`, action: t('pages.delete') }).then(async ok => { if (ok && await act(() => del(`${BASE}/knowledge/${encodeURIComponent(k.id)}`), { invalidate: [['owui-catalog']] })) setOpen(null); })} />
              </div>
              {item.isPending ? <Spinner /> : item.error ? <ErrorBox error={item.error} /> : (item.data.files.length === 0 ? <p className="small text-soft">{t('chat.nofiles')}</p> : (
                <ul className="app-owc-admin-list">
                  {item.data.files.map(f => (
                    <li key={f.id}><Icon name="file-text" /><span className="flex-grow-1 text-truncate">{f.name}</span><small className="text-soft">{size(f.size ?? undefined)}</small>
                      <Button size="sm" variant="ghost" icon="cross" aria-label={t('pages.removefile')} onClick={() => void act(() => del(`${BASE}/knowledge/${encodeURIComponent(k.id)}/files/${encodeURIComponent(f.id)}`), { invalidate: [['owui-knowledge']] })} /></li>
                  ))}
                </ul>
              ))}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** What the OpenWebUI instance has: its address and version, tools, functions and prompts (read only) */
function FunctionsDialog({ catalog, status, onClose }: { catalog: Catalog; status: Status; onClose: () => void }) {
  const t = useT();
  const section = (title: string, rows: { key: string; name: string; info: string; badge?: ReactNode }[], empty: string) => (
    <div className="mb-3">
      <h6>{title}</h6>
      {rows.length === 0 ? <p className="small text-soft">{empty}</p> : <ul className="app-owc-admin-list">{rows.map(r => <li key={r.key}><span className="flex-grow-1 min-w-0"><strong>{r.name}</strong>{r.badge}<span className="d-block small text-soft text-truncate">{r.info}</span></span></li>)}</ul>}
    </div>
  );
  return (
    <Dialog open onClose={onClose} size="lg" title={t('chat.functions')}>
      <p className="small text-soft">OpenWebUI {status.version ?? ''} · {status.url} · {t('chat.functionsinfo')}</p>
      {section(t('chat.tools'), catalog.tools.map(x => ({ key: x.id, name: x.name, info: x.description || x.id })), t('chat.notools'))}
      {section(t('chat.functions'), catalog.functions.map(f => ({ key: f.id, name: f.name, info: f.description || f.id, badge: <> <Badge tone={f.active ? 'green' : 'gray'}>{f.type}</Badge>{f.global && <> <Badge tone="blue">global</Badge></>}</> })), t('chat.nofunctions'))}
      {section(t('chat.prompts'), catalog.prompts.map(p => ({ key: p.command, name: `/${p.command}`, info: p.title })), t('chat.noprompts'))}
      <DialogFooter cancelLabel={t('pages.close')} />
    </Dialog>
  );
}
