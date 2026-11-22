import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import { ApiError, get, post, SIGNED_OUT, type Me } from './api';
import { ChatPage } from './Chat';
import { Login } from './Login';
import { FeedbackProvider, Spinner, useT } from './ui';

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false } } });

function App() {
  const t = useT();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [notice, setNotice] = useState('');
  useEffect(() => { get<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  // A 401 from any call means the sign-in ended (or OpenWebUI's token expired)
  useEffect(() => {
    const out = () => { setMe(m => { if (m) setNotice(t('login.signedout')); return null; }); qc.clear(); };
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, [t]);
  const logout = async () => { await post('/api/logout').catch(() => undefined); qc.clear(); setNotice(''); setMe(null); };
  if (me === undefined) return <Spinner />;
  if (!me) return <Login notice={notice} onDone={m => { setNotice(''); setMe(m); }} />;
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<ChatPage me={me} onLogout={() => void logout()} />} />
        <Route path="/c/:id" element={<ChatPage me={me} onLogout={() => void logout()} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <FeedbackProvider><App /></FeedbackProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
