import { useMemo } from 'react';
import { useLocation, useNavigate, useParams as params } from 'react-router-dom';
import { openSystemBrowser } from '../platform/systemBrowser';
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => {
    const visit = (href: string, replace: boolean) => {
      if (/^https:\/\//.test(href)) { void openSystemBrowser(href); return; }
      if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) throw new Error('Invalid app route.');
      navigate(href, { replace });
    };
    return { push: (href: string) => visit(href, false), replace: (href: string) => visit(href, true),
      back: () => navigate(-1), forward: () => navigate(1), prefetch: async () => {},
      refresh: () => window.dispatchEvent(new Event('creatornet:refresh')) };
  }, [navigate]);
}
export function useSearchParams() { const { search } = useLocation(); return useMemo(() => new URLSearchParams(search), [search]); }
export function usePathname() { return useLocation().pathname; }
export function useParams() { return params(); }
