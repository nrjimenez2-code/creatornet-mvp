import { createRoot } from 'react-dom/client';
import { readAppConfig } from './config';
import './app.css';
const root = createRoot(document.getElementById('root')!);
async function start() {
  try {
    readAppConfig();
    const [{ setApiTransport }, { nativeApiFetch }, { default: App }] = await Promise.all([
      import('@/lib/apiFetch'), import('./platform/api'), import('./App'),
    ]);
    setApiTransport(nativeApiFetch);
    root.render(<App />);
  } catch {
    root.render(<main className="app-page"><h1>CreatorNet</h1><p role="alert">CreatorNet could not start. Please reopen the app.</p></main>);
  }
}
void start();
