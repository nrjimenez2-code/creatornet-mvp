import { forwardRef, type ImgHTMLAttributes } from 'react';
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string | { src: string }; fill?: boolean; priority?: boolean; quality?: number; unoptimized?: boolean; loader?: unknown; placeholder?: string; blurDataURL?: string };
export function getImageProps({ src, fill, priority, quality: _quality, unoptimized: _unoptimized, loader: _loader, placeholder: _placeholder, blurDataURL: _blur, ...props }: Props) {
  return { props: { ...props, src: typeof src === 'string' ? src : src.src, loading: priority ? 'eager' as const : props.loading,
    ...(fill ? { style: { position: 'absolute' as const, inset: 0, width: '100%', height: '100%', ...props.style } } : {}) } };
}
export default forwardRef<HTMLImageElement, Props>(function Image(props, ref) { return <img ref={ref} {...getImageProps(props).props} alt={props.alt ?? ''} />; });
