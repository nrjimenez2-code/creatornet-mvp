import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '@/lib/useUser';
import { beginOAuth, cancelOAuth, emailCode } from '../platform/auth';
import { supabase } from '../platform/supabase';
export default function Auth() {
  const { session, loading } = useUser(); const navigate = useNavigate();
  const [email, setEmail] = useState(''); const [code, setCode] = useState('');
  const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  useEffect(() => { if (!wait) return; const timer = window.setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(timer); }, [wait]);
  useEffect(() => {
    if (loading || !session) return;
    let cancelled = false;
    void supabase.from('profiles').select('interests').eq('id', session.user.id).maybeSingle().then(({ data, error }) => {
      if (cancelled) return;
      if (error) { setError('Could not load your profile. Please try again.'); return; }
      navigate(Array.isArray(data?.interests) && data.interests.length ? '/dashboard' : '/onboarding', { replace: true });
    });
    return () => { cancelled = true; };
  }, [session, loading, navigate]);
  const perform = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in. Please try again.'); } finally { setBusy(false); } };
  return <main className="app-page"><img src="/creatornet-mark.png" width="64" height="64" alt="" /><h1>Welcome to CreatorNet</h1>
    <button type="button" className="app-action w-full" disabled={busy} onClick={() => { void perform(() => beginOAuth('apple')); }}>Continue with Apple</button>
    <button type="button" className="app-action w-full" disabled={busy} onClick={() => { void perform(() => beginOAuth('google')); }}>Continue with Google</button>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => { await emailCode(email, sent ? code : undefined); if (!sent) { setSent(true); setWait(60); } }); }}>
      <label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" value={email} readOnly={sent} onChange={event => setEmail(event.target.value)} required />
      {sent && <><label htmlFor="code">Six-digit code</label><input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required /></>}
      <button type="submit" className="app-action app-action-primary w-full" disabled={busy}>{busy ? 'Please wait…' : sent ? 'Sign in' : 'Send a code'}</button>
    </form>
    {sent && <button type="button" className="app-action w-full" disabled={busy || wait > 0} onClick={() => { void perform(async () => { await emailCode(email); setWait(60); }); }}>{wait ? `Resend code in ${wait}s` : 'Resend code'}</button>}
    <button type="button" className="app-action w-full" onClick={() => { void perform(cancelOAuth); }}>Cancel browser sign-in</button>
    {error && <p role="alert">{error}</p>}
  </main>;
}
