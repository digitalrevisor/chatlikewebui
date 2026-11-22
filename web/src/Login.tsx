// Sign-in with the person's OpenWebUI account (e-mail and password), or with an OpenWebUI API key
import { useState } from 'react';
import { post, type Me } from './api';
import { Button, Field, Icon, Input, useT, usePageTitle } from './ui';

export function Login({ onDone, notice }: { onDone: (me: Me) => void; notice?: string }) {
  const t = useT();
  usePageTitle(t('login.title'));
  const [withKey, setWithKey] = useState(false);
  const [v, setV] = useState({ email: '', password: '', apiKey: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { onDone(await post<Me>('/api/login', withKey ? { apiKey: v.apiKey } : { email: v.email, password: v.password })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const ready = withKey ? v.apiKey.trim().length >= 10 : v.email.trim() && v.password;
  return (
    <main className="app-login">
      <form className="app-login-card" onSubmit={e => { e.preventDefault(); if (ready) void submit(); }}>
        <span className="app-owc-hero-icon"><Icon name="spark-fill" /></span>
        <h1>{t('login.title')}</h1>
        <p className="text-soft">{t('login.sub')}</p>
        {notice && !error && <div className="alert alert-info py-2 px-3 small">{notice}</div>}
        {error && <div className="alert alert-danger py-2 px-3 small" role="alert">{error}</div>}
        {withKey ? (
          <Field label={t('login.apikey')} hint={t('login.apikeyhint')}><Input type="password" autoComplete="off" autoFocus value={v.apiKey} onChange={e => setV({ ...v, apiKey: e.target.value })} placeholder="sk-..." /></Field>
        ) : (
          <>
            <Field label={t('login.email')}><Input type="email" autoComplete="username" autoFocus required value={v.email} onChange={e => setV({ ...v, email: e.target.value })} /></Field>
            <Field label={t('login.password')}><Input type="password" autoComplete="current-password" required value={v.password} onChange={e => setV({ ...v, password: e.target.value })} /></Field>
          </>
        )}
        <Button type="submit" variant="primary" className="w-100" busy={busy} disabled={!ready || busy}>{t('login.submit')}</Button>
        <button type="button" className="app-login-switch" onClick={() => { setWithKey(!withKey); setError(''); }}>{t(withKey ? 'login.withpassword' : 'login.withkey')}</button>
      </form>
    </main>
  );
}
