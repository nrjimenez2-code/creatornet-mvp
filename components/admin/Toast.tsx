"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconAlert, IconCheckCircle, IconEyeOff } from "@/components/admin/icons";

export type ToastKind = "success" | "info" | "danger";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  toast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_LIFETIME_MS = 3600;
const MAX_VISIBLE_TOASTS = 3;

const KIND_STYLES: Record<ToastKind, { chip: string; icon: ReactNode }> = {
  success: {
    chip: "bg-emerald-100 text-emerald-600",
    icon: <IconCheckCircle size={15} />,
  },
  info: {
    chip: "bg-[#f3eefc] text-[#7c5cbf]",
    icon: <IconEyeOff size={15} />,
  },
  danger: {
    chip: "bg-red-100 text-red-600",
    icon: <IconAlert size={15} />,
  },
};

/**
 * Lightweight toast system for action feedback ("@user banned", "Video
 * approved"). Bottom-right stack, auto-dismiss, aria-live so screen readers
 * announce outcomes too.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timeoutsRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const pending = timeoutsRef.current.get(id);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE_TOASTS - 1)), { id, kind, message }]);
      timeoutsRef.current.set(
        id,
        window.setTimeout(() => dismiss(id), TOAST_LIFETIME_MS),
      );
    },
    [dismiss],
  );

  // Clear every pending auto-dismiss when the provider unmounts (navigating
  // out of /admin) so no timer fires setState on a dead component.
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
      timeouts.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-5 bottom-5 z-[60] flex w-full max-w-xs flex-col gap-2"
      >
        {toasts.map((item) => {
          const style = KIND_STYLES[item.kind];
          return (
            <div
              key={item.id}
              className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[#e9e3f7] bg-white/95 px-3.5 py-3 shadow-[0_8px_28px_rgba(24,16,44,0.16)] backdrop-blur motion-safe:animate-[toastIn_0.25s_ease-out]"
            >
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${style.chip}`}
              >
                {style.icon}
              </span>
              <p className="min-w-0 flex-1 text-sm font-medium text-zinc-800">
                {item.message}
              </p>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
