import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { openSystemBrowser } from '../platform/systemBrowser';
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string | { pathname?: string; query?: Record<string, string> }; prefetch?: boolean; replace?: boolean; scroll?: boolean };
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _prefetch, scroll: _scroll, replace, onClick, ...props }, ref) {
  const value = typeof href === 'string' ? href : (href.pathname ?? '/') + (href.query ? '?' + new URLSearchParams(href.query) : '');
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return <RouterLink to={value} replace={replace} onClick={onClick} ref={ref} {...props} />;
  const open = (event: MouseEvent<HTMLAnchorElement>) => { onClick?.(event); if (!event.defaultPrevented) { event.preventDefault(); void openSystemBrowser(value); } };
  return <a href={value} onClick={open} ref={ref} {...props} />;
});
export default Link;
