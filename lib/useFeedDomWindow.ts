"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

const OVERSCAN = 6;

// Keep native scrolling and the total scroll height while bounding actual
// sections. VideoCard retains its smaller, independently controlled window.
export function useFeedDomWindow(
  rootRef: RefObject<HTMLDivElement | null>,
  sectionsRef: RefObject<Map<string, HTMLElement>>,
  count: number,
  loading: boolean,
) {
  const [center, setCenter] = useState(0);
  const heightRef = useRef(0);
  const countRef = useRef(count);
  const snapRestoreRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    countRef.current = count;
    const root = rootRef.current;
    if (!root || loading) {
      setCenter(0);
      return;
    }
    let frame = 0;
    const readPosition = () => {
      frame = 0;
      if (heightRef.current > 0) {
        const index = Math.max(0, Math.min(countRef.current - 1, Math.round(root.scrollTop / heightRef.current)));
        setCenter(index);
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(readPosition);
    };
    const measure = () => {
      const section = sectionsRef.current.values().next().value;
      const height = section?.getBoundingClientRect().height ?? 0;
      if (height <= 0) return;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      heightRef.current = height;
      // Native scroll snap already follows the current section when its size
      // changes. Scaling scrollTop again would move the viewer twice.
      readPosition();
    };
    measure();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resize?.observe(root);
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      snapRestoreRef.current?.();
      snapRestoreRef.current = null;
    };
  }, [rootRef, sectionsRef, count, loading]);

  const scrollToIndex = useCallback((requested: number) => {
    const root = rootRef.current;
    const height = heightRef.current;
    if (!root || height <= 0 || countRef.current === 0) return;
    const index = Math.max(0, Math.min(countRef.current - 1, requested));
    const current = Math.round(root.scrollTop / height);
    if (Math.abs(index - current) <= OVERSCAN) {
      root.scrollTo({ top: index * height, behavior: "smooth" });
      return;
    }
    // A distant highlighted post has no DOM node yet. Jump directly and
    // restore snapping after its bounded window has reached the DOM.
    snapRestoreRef.current?.();
    const previous = root.style.scrollSnapType;
    let frame = 0;
    const restore = () => {
      if (frame) cancelAnimationFrame(frame);
      root.style.scrollSnapType = previous;
      snapRestoreRef.current = null;
    };
    snapRestoreRef.current = restore;
    root.style.scrollSnapType = "none";
    setCenter(index);
    root.scrollTo({ top: index * height, behavior: "instant" });
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(restore); });
  }, [rootRef]);

  const boundedCenter = Math.max(0, Math.min(count - 1, center));
  return {
    start: Math.max(0, boundedCenter - OVERSCAN),
    end: Math.min(count, boundedCenter + OVERSCAN + 1),
    scrollToIndex,
  };
}
