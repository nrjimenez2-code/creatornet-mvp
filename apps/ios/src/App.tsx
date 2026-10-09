import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { App as NativeApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import MobileTabNav from '@/components/MobileTabNav';
import SoundPreferenceSync from '@/components/SoundPreferenceSync';
import { UserProvider, useUser } from '@/lib/useUser';
import { parseAppLink } from '@creatornet/shared/appLinks';
import { readAppConfig } from './config';
import { completeOAuth, logout } from './platform/auth';
import { supabase } from './platform/supabase';
import { setNativePageVisible } from '@/lib/browserVisibility';
const Feed = lazy(() => import('@/app/dashboard/page'));
const Auth = lazy(() => import('./pages/Auth'));
const Profile = lazy(() => import('./pages/Profile'));
const EditProfile = lazy(() => import('@/app/profile/edit/page'));
const Onboarding = lazy(() => import('@/app/onboarding/page'));
const SearchPage = lazy(() => import('@/app/search/page'));
const TagFeedPage = lazy(() => import('@/app/tag/[hashtag]/page'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Library = lazy(() => import('./pages/Library'));
const Watch = lazy(() => import('./pages/Watch'));
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="app-page"><p role="alert">This page could not be opened. Please reopen CreatorNet.</p></main> : this.props.children; }
}
function AppShell() {
  const navigate = useNavigate(); const { userId } = useUser();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false; const cleanup: (() => Promise<void>)[] = [];
    const open = async (value: string) => {
      const link = parseAppLink(value, readAppConfig().websiteOrigin); if (!link || disposed) return;
      if (link.kind === 'auth') { try { if (await completeOAuth(link) && !disposed) navigate('/auth', { replace: true }); } catch { if (!disposed) navigate('/auth', { replace: true }); } }
      if (link.kind === 'route') navigate(link.path);
      // Commerce returns are added only with server-owned, account-bound contexts.
    };
    void NativeApp.addListener('appUrlOpen', event => { void open(event.url); }).then(handle => { if (disposed) void handle.remove(); else cleanup.push(() => handle.remove()); });
    void NativeApp.getLaunchUrl().then(result => { if (result) void open(result.url); });
    void NativeApp.getState().then(({ isActive }) => { if (!disposed) setNativePageVisible(isActive); });
    void NativeApp.addListener('appStateChange', ({ isActive }) => {
      setNativePageVisible(isActive);
      if (isActive) { supabase.auth.startAutoRefresh(); window.dispatchEvent(new Event('creatornet:refresh')); }
      else supabase.auth.stopAutoRefresh();
    }).then(handle => { if (disposed) void handle.remove(); else cleanup.push(() => handle.remove()); });
    return () => { disposed = true; setNativePageVisible(null); cleanup.forEach(remove => { void remove(); }); };
  }, [navigate]);
  return <div className="app-shell">{import.meta.env.DEV && import.meta.env.VITE_CREATORNET_RENDERER_FIXTURE === 'true' && <p style={{ position: 'fixed', top: 0, right: 0, zIndex: 100, background: '#261d4b', padding: '4px 8px', fontSize: 11 }}>Renderer fixture · no hosted/device acceptance</p>}<Suspense fallback={<main className="app-page" aria-busy="true">Loading…</main>}><Routes>
    <Route path="/" element={<Navigate to="/dashboard" replace />} /><Route path="/dashboard" element={<Feed />} />
    <Route path="/auth" element={<Auth />} /><Route path="/onboarding" element={<Onboarding />} />
    <Route path="/search" element={<SearchPage />} /><Route path="/tag/:hashtag" element={<TagFeedPage />} /><Route path="/library" element={<Library />} /><Route path="/watch/:postId" element={<Watch />} /><Route path="/profile" element={<Profile />} />
    <Route path="/profile/edit" element={<EditProfile />} /><Route path="/creators/:creatorId" element={<Profile />} />
    <Route path="/profile/:creatorId" element={<Profile />} /><Route path="/notifications" element={<Notifications />} />
    <Route path="/settings" element={<main className="app-page"><h1>Settings</h1>{userId && <button type="button" className="app-action" onClick={() => { void logout().then(() => navigate('/auth', { replace: true })); }}>Sign out</button>}</main>} />
    <Route path="*" element={<main className="app-page"><p role="alert">This page could not be opened.</p></main>} />
  </Routes></Suspense><Suspense fallback={null}><MobileTabNav /></Suspense><SoundPreferenceSync /></div>;
}
export default function App() { return <AppErrorBoundary><BrowserRouter><UserProvider><AppShell /></UserProvider></BrowserRouter></AppErrorBoundary>; }
