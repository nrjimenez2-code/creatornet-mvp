import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, here, 'VITE_'), ...process.env };
  for (const key of ['VITE_CREATORNET_API_ORIGIN', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
    if (!env[key]) throw new Error(`Missing public app setting: ${key}`);
  }
  return {
    plugins: [react(), {
      name: 'creatornet-client-boundary',
      resolveId(id) {
        if (['server-only', 'next/headers', 'next/server'].includes(id) || id.startsWith('node:')) throw new Error(`Server code cannot enter the iPhone bundle: ${id}`);
      },
    }],
    publicDir: path.join(root, 'public'),
    resolve: { alias: [
      { find: '@/lib/supabaseClient', replacement: path.join(here, 'src/platform/supabase.ts') },
      ...['navigation', 'link', 'image', 'dynamic'].map(name => ({ find: `next/${name}`, replacement: path.join(here, `src/adapters/next-${name}.tsx`) })),
      { find: /^@creatornet\/shared\/(.*)$/, replacement: path.join(root, 'packages/shared/src/$1.ts') },
      { find: '@', replacement: root },
    ], dedupe: ['react', 'react-dom', '@supabase/supabase-js'] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL),
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_PUBLISHABLE_KEY),
      'process.env.NEXT_PUBLIC_SITE_URL': JSON.stringify(env.VITE_CREATORNET_API_ORIGIN),
      'process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_ENABLED': JSON.stringify('false'),
      'process.env.NEXT_PUBLIC_POSTHOG_KEY': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_POSTHOG_HOST': JSON.stringify(''),
    },
    css: { postcss: { plugins: [tailwindcss()] } },
    server: { strictPort: true, fs: { allow: [root] } },
    build: { target: 'es2022', sourcemap: false, outDir: 'dist', emptyOutDir: true },
  };
});
