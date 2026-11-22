// Small building blocks for the page: icons, buttons, dialogs, menus, messages and confirmations.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  ArrowUp, Bookmark, BookmarkCheck, BookOpen, Bot, Check, CircleAlert, CircleCheck, ChevronDown, Code, Copy, Ellipsis, File, FileText, Globe, Image,
  KeyRound, Link, LogOut, Menu as MenuIcon, Paperclip, Pencil, Plus, RefreshCw, Settings, Settings2, SlidersHorizontal, Sparkles, Square, SquarePen,
  Trash2, Upload, UserPlus, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { NO } from './i18n';

const ICONS: Record<string, LucideIcon> = {
  'alert-circle': CircleAlert, 'arrow-up': ArrowUp, book: BookOpen, bookmark: Bookmark, 'bookmark-fill': BookmarkCheck, check: Check, 'check-circle': CircleCheck,
  'chevron-down': ChevronDown, clip: Paperclip, code: Code, copy: Copy, cross: X, edit: Pencil, 'edit-alt': SquarePen, file: File, 'file-text': FileText,
  globe: Globe, img: Image, link: Link, 'lock-alt': KeyRound, menu: MenuIcon, 'more-h': Ellipsis, plus: Plus, regen: RefreshCw, setting: Settings,
  'setting-alt': SlidersHorizontal, 'setting-fill': Wrench, 'spark-fill': Sparkles, 'stop-fill': Square, trash: Trash2, upload: Upload, 'user-add': UserPlus,
  'user-circle-fill': Bot, logout: LogOut, settings2: Settings2,
};

export function Icon({ name }: { name: string }) {
  const I = ICONS[name];
  return I ? <I className={`icon ni-${name}`} size="1em" strokeWidth={2} aria-hidden="true" fill={name === 'stop-fill' ? 'currentColor' : 'none'} /> : null;
}

export const useT = () => useCallback((k: string) => NO[k] ?? k, []);
export function usePageTitle(title: string) { useEffect(() => { document.title = title; }, [title]); }
export const date = (v: string | null | undefined) => (v ? new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(v)) : '');

/** Answers may hold HTML from Markdown: only known-safe tags, links and pictures survive */
const RICH = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'DIV', 'S', 'DEL', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'PRE', 'CODE']);
export function safeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Element) => {
    for (const el of [...node.children]) {
      walk(el);
      if (!RICH.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH'].includes(el.tagName.toUpperCase())) el.remove();
        else el.replaceWith(...el.childNodes);
        continue;
      }
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      const src = el.tagName === 'IMG' ? el.getAttribute('src') : null;
      const span = ['TD', 'TH'].includes(el.tagName) ? [el.getAttribute('colspan'), el.getAttribute('rowspan')] : null;
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      if (src && /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(src)) el.setAttribute('src', src);
      else if (el.tagName === 'IMG') el.remove();
      if (span?.[0] && /^\d+$/.test(span[0])) el.setAttribute('colspan', span[0]);
      if (span?.[1] && /^\d+$/.test(span[1])) el.setAttribute('rowspan', span[1]);
      if (href && /^https?:\/\//i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = { primary: 'btn-dark', secondary: 'btn-outline-secondary', ghost: 'btn-light app-btn-ghost', danger: 'btn-danger' };
export function Button({ variant = 'secondary', size, icon, busy, className, children, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm'; icon?: string; busy?: boolean }) {
  return (
    <button type={type} className={`btn ${VARIANT[variant]}${size ? ` btn-${size}` : ''} app-btn ${className ?? ''}`} {...rest}>
      {busy ? <span className="spinner-border spinner-border-sm" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {children && <span>{children}</span>}
    </button>
  );
}

const TONE: Record<string, string> = { red: 'text-bg-danger', green: 'text-bg-success', gray: 'text-bg-secondary', blue: 'text-bg-primary' };
export const Badge = ({ tone = 'gray', children }: { tone?: string; children: ReactNode }) => <span className={`badge rounded-pill ${TONE[tone] ?? TONE.gray}`}>{children}</span>;
export const Spinner = () => <div className="d-flex justify-content-center p-3"><span className="spinner-border spinner-border-sm text-secondary" role="status" aria-label="Laster" /></div>;
export const ErrorBox = ({ error }: { error: unknown }) => <div className="alert alert-danger py-2 px-3 small mb-2" role="alert">{(error as Error)?.message ?? String(error)}</div>;
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="d-block"><span className="form-label d-block small fw-semibold mb-1">{label}</span>{children}{hint && <span className="form-text d-block">{hint}</span>}</label>;
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`form-control ${p.className ?? ''}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`form-control ${p.className ?? ''}`} />;

const DialogClose = createContext<() => void>(() => undefined);
export function Dialog({ open, onClose, title, size, children }: { open: boolean; onClose: () => void; title: string; size?: 'lg' | 'xl'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => { document.removeEventListener('keydown', key); before?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="app-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`app-dialog app-dialog-${size ?? 'md'}`}>
        <div className="app-dialog-head"><h5 className="mb-0">{title}</h5><button type="button" className="app-owc-icon-btn" aria-label="Lukk" onClick={onClose}><Icon name="cross" /></button></div>
        <div className="app-dialog-body"><DialogClose.Provider value={onClose}>{children}</DialogClose.Provider></div>
      </div>
    </div>
  );
}
export function DialogFooter({ submit, icon, busy, disabled, onSubmit, cancelLabel }: { submit?: string; icon?: string; busy?: boolean; disabled?: boolean; onSubmit?: () => void; cancelLabel?: string }) {
  const close = useContext(DialogClose);
  return (
    <div className="d-flex justify-content-end gap-2 pt-2">
      <Button variant={submit ? 'ghost' : 'secondary'} onClick={close}>{cancelLabel ?? NO['pages.cancel'] ?? 'Avbryt'}</Button>
      {submit && <Button variant="primary" icon={icon} busy={busy} disabled={disabled} onClick={e => { e.preventDefault(); onSubmit?.(); }}>{submit}</Button>}
    </div>
  );
}

export function Menu({ trigger, items }: { trigger: ReactNode; items: { label: string; icon?: string; danger?: boolean; divider?: boolean; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className="position-relative" onClickCapture={e => { if ((e.target as HTMLElement).closest('[data-menu-trigger]')) { e.stopPropagation(); setOpen(o => !o); } }}>
      <span data-menu-trigger data-state={open ? 'open' : 'closed'} className="d-inline-flex">{trigger}</span>
      {open && (
        <div className="app-menu" role="menu">
          {items.map(i => (
            <div key={i.label}>
              {i.divider && <hr className="my-1" />}
              <button type="button" role="menuitem" className={`app-owc-pop-item${i.danger ? ' text-danger' : ''}`} onClick={() => { setOpen(false); i.onSelect(); }}>{i.icon && <Icon name={i.icon} />}{i.label}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- messages ("toasts") and confirmations
type Toast = { id: number; kind: 'success' | 'error'; text: string };
type Ask = { title: string; action: string; resolve: (ok: boolean) => void };
const Feedback = createContext<{ toast: (kind: Toast['kind'], text: string) => void; confirm: (o: { title: string; action: string }) => Promise<boolean> }>({ toast: () => undefined, confirm: async () => false });
export const useFeedback = () => useContext(Feedback);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, kind, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const confirm = useCallback((o: { title: string; action: string }) => new Promise<boolean>(resolve => setAsk({ ...o, resolve })), []);
  const answer = (ok: boolean) => { ask?.resolve(ok); setAsk(null); };
  return (
    <Feedback.Provider value={{ toast, confirm }}>
      {children}
      <div className="app-toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`app-toast is-${t.kind}`}><Icon name={t.kind === 'error' ? 'alert-circle' : 'check-circle'} />{t.text}</div>)}</div>
      {ask && (
        <Dialog open onClose={() => answer(false)} title={ask.title}>
          <div className="d-flex justify-content-end gap-2">
            <Button variant="ghost" onClick={() => answer(false)}>{NO['pages.cancel'] ?? 'Avbryt'}</Button>
            <Button variant="danger" autoFocus onClick={() => answer(true)}>{ask.action}</Button>
          </div>
        </Dialog>
      )}
    </Feedback.Provider>
  );
}

/** Runs a change, shows its error (or `success`), refreshes `invalidate`, and says whether it worked */
export function useAct() {
  const qc = useQueryClient();
  const { toast } = useFeedback();
  return useCallback(async (f: () => Promise<unknown>, o: { success?: string; invalidate?: QueryKey[] } = {}) => {
    try {
      await f();
      if (o.success) toast('success', o.success);
      await Promise.all((o.invalidate ?? []).map(k => qc.invalidateQueries({ queryKey: k })));
      return true;
    } catch (e) {
      toast('error', (e as Error).message);
      return false;
    }
  }, [qc, toast]);
}
