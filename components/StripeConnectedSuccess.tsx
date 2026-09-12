"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@/lib/useUser";
import styles from "./stripe-connected-success.module.css";

/** Only the completed onboarding return can open this; ordinary visits stay quiet. */
export default function StripeConnectedSuccess() {
  const params = useSearchParams();
  const returnedSuccessfully = params?.get("connect") === "success";
  const { userId, session, loading } = useUser();
  const token = session?.access_token;
  const [confirmedUser, setConfirmedUser] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = !!userId && confirmedUser === userId;

  useEffect(() => {
    if (!returnedSuccessfully || loading || !userId || !token) return;
    const controller = new AbortController();
    const key = `creatornet:stripe-connected:v1:${userId}`;
    const consumeReturn = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      window.history.replaceState(window.history.state, "", url);
    };
    try {
      if (localStorage.getItem(key) === "seen") {
        consumeReturn();
        return;
      }
    } catch { /* URL consumption also prevents replay when storage is unavailable. */ }

    void (async () => {
      try {
        // A URL flag alone is not evidence that payouts are ready.
        const response = await fetch("/api/stripe/connect/status", {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const status = await response.json();
        if (controller.signal.aborted) return;
        if (status.connected === true && status.onboarding_complete === true) {
          setConfirmedUser(userId);
          try { localStorage.setItem(key, "seen"); } catch { /* Best effort. */ }
        }
        consumeReturn();
      } catch { /* Failed or canceled verification must never show success. */ }
    })();
    return () => controller.abort();
  }, [returnedSuccessfully, loading, userId, token]);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  const dismiss = () => setConfirmedUser(null);

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="stripe-connected-title"
      aria-describedby="stripe-connected-description" onCancel={dismiss}>
      <button type="button" className={styles.close} aria-label="Close Stripe confirmation" onClick={dismiss}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <div className={styles.check} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m5 12 4.5 4.5L19 7" /></svg>
      </div>
      <h2 id="stripe-connected-title">Stripe Connected!</h2>
      <p id="stripe-connected-description">You’re all set. Start earning today.</p>
      <button type="button" className={styles.primary} onClick={dismiss} autoFocus>Got it</button>
    </dialog>
  );
}
