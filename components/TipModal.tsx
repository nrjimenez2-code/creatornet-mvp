"use client";

import { useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { StripeExpressCheckoutElementConfirmEvent } from "@stripe/stripe-js";

type Props = {
  open: boolean;
  postId: string;
  creatorName: string;
  resumeTipId?: string | null;
  onClose: () => void;
};

type Stage = "amount" | "review" | "payment" | "processing" | "paid" | "failed" | "canceled";

export default function TipModal({ open, postId, creatorName, resumeTipId = null, onClose }: Props) {
  const [stage, setStage] = useState<Stage>("amount");
  const [amountCents, setAmountCents] = useState(500);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [paymentReady, setPaymentReady] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [tipId, setTipId] = useState<string | null>(null);
  const requestKey = useRef("");
  const resumeConsumed = useRef(false);
  const paymentMount = useRef<HTMLDivElement>(null);
  const walletMount = useRef<HTMLDivElement>(null);
  const paymentInFlight = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<null | (() => Promise<void>)>(null);
  const postRef = useRef(postId);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (postRef.current !== postId) {
        postRef.current = postId;
        resumeConsumed.current = false;
        requestKey.current = "";
        setClientSecret(null); setTipId(null); setPaymentReady(false); confirmRef.current = null;
      }
      if (resumeTipId && !resumeConsumed.current) {
        resumeConsumed.current = true;
        // Keep the returned payment active when the dialog is closed and reopened.
        requestKey.current = `resume:${resumeTipId}`;
        setTipId(resumeTipId); setStage("processing"); setError(null); setSubmitting(false);
        return;
      }
      if (requestKey.current) return;
      requestKey.current = crypto.randomUUID();
      setStage("amount"); setAmountCents(500); setCustom(""); setError(null);
      setSubmitting(false); setClientSecret(null); setTipId(null); setPaymentReady(false); confirmRef.current = null;
    });
    return () => { cancelled = true; };
  }, [open, postId, resumeTipId]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1)!;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previous; previousFocus?.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open || !clientSecret || !paymentMount.current || !walletMount.current || stage !== "payment") return;
    let cancelled = false;
    setPaymentReady(false);
    let element: { mount(target: HTMLElement): void; destroy(): void } | null = null;
    let walletElement: { mount(target: HTMLElement): void; destroy(): void } | null = null;
    (async () => {
      const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      if (!key) throw new Error("Payments are not configured.");
      const stripe = await loadStripe(key);
      if (!stripe || cancelled || !paymentMount.current || !walletMount.current) return;
      const checkout = stripe.initCheckoutElementsSdk({
        clientSecret,
        elementsOptions: {
          appearance: { theme: "night", variables: { colorPrimary: "#655BFF", borderRadius: "10px" } },
        },
      });
      element = checkout.createPaymentElement({ layout: "accordion" });
      element.mount(paymentMount.current);
      const wallet = checkout.createExpressCheckoutElement();
      walletElement = wallet;
      wallet.mount(walletMount.current);
      const loaded = await checkout.loadActions();
      if (loaded.type === "error") throw new Error(loaded.error.message);
      if (cancelled) return;
      const confirm = async (expressCheckoutConfirmEvent?: StripeExpressCheckoutElementConfirmEvent) => {
        if (paymentInFlight.current) return;
        paymentInFlight.current = true;
        setSubmitting(true); setError(null);
        try {
          const result = await loaded.actions.confirm({ redirect: "if_required", expressCheckoutConfirmEvent });
          if (result.type === "error") { setError(result.error.message); return; }
          setStage("processing");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Payment could not be confirmed.");
        } finally {
          paymentInFlight.current = false;
          setSubmitting(false);
        }
      };
      confirmRef.current = () => confirm();
      wallet.on("confirm", (event) => { void confirm(event); });
      setPaymentReady(true);
    })().catch((cause) => setError(cause instanceof Error ? cause.message : "Payment form could not be loaded."));
    return () => { cancelled = true; confirmRef.current = null; element?.destroy(); walletElement?.destroy(); };
  }, [clientSecret, open, stage]);

  useEffect(() => {
    if (stage !== "processing" || !tipId) return;
    let cancelled = false, attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const response = await fetch(`/api/tips/${encodeURIComponent(tipId)}/status`, { credentials: "include", cache: "no-store" });
        const data = await response.json();
        if (Number.isSafeInteger(data.amountCents)) setAmountCents(data.amountCents);
        if (data.status === "paid") { setStage("paid"); return; }
        if (data.status === "failed") { setStage("failed"); setError("The tip was not completed."); return; }
        if (data.status === "canceled") { setStage("canceled"); return; }
      } catch { /* keep the webhook-authoritative pending state */ }
      if (attempts < 20) window.setTimeout(poll, 1500);
      else setError("Payment is still processing. It will appear in your payment history when confirmed.");
    };
    void poll();
    return () => { cancelled = true; };
  }, [stage, tipId]);

  if (!open) return null;
  const parseCustom = () => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(custom)) return null;
    const cents = Math.round(Number(custom) * 100);
    return Number.isSafeInteger(cents) && cents >= 500 && cents <= 50_000 ? cents : null;
  };
  const chooseCustom = () => {
    const cents = parseCustom();
    if (cents === null) { setError("Enter an amount from $5 to $500."); return; }
    setAmountCents(cents); setError(null); setStage("review");
  };
  const startCheckout = async () => {
    setSubmitting(true); setError(null);
    try {
      const response = await fetch("/api/tips/checkout", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, amountCents, requestKey: requestKey.current }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.clientSecret || !data.tipId) throw new Error(data.error || "Tip checkout could not be started.");
      setClientSecret(data.clientSecret); setTipId(data.tipId); setStage("payment");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Tip checkout could not be started."); }
    finally { setSubmitting(false); }
  };
  const retry = () => {
    requestKey.current = crypto.randomUUID(); setClientSecret(null); setTipId(null); setPaymentReady(false);
    setError(null); setSubmitting(false); setStage("review");
  };
  const close = () => {
    if (stage === "paid") {
      requestKey.current = ""; setClientSecret(null); setTipId(null); setPaymentReady(false); setStage("amount");
    }
    onClose();
  };

  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="presentation">
    <button className="absolute inset-0" onClick={close} aria-label="Close tip dialog" />
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tip-dialog-title" className="relative w-full max-w-md rounded-t-3xl border border-white/10 bg-[#09090b] p-5 text-white shadow-2xl outline-none sm:rounded-3xl">
      <div className="flex items-start justify-between gap-4">
        <div><h2 id="tip-dialog-title" className="text-xl font-semibold">Tip {creatorName}</h2><p className="mt-1 text-sm text-white/60">Tips support the creator and do not unlock content.</p></div>
        <button type="button" onClick={close} className="rounded-full p-2 text-white/70 hover:bg-white/10" aria-label="Close">✕</button>
      </div>
      {stage === "amount" && <div className="mt-6 space-y-4">
        <div className="grid grid-cols-3 gap-2">{[500, 1000, 2000].map((cents) => <button key={cents} type="button" onClick={() => { setAmountCents(cents); setStage("review"); }} className="rounded-xl border border-white/15 bg-white/5 py-3 font-semibold hover:border-[#655BFF] hover:bg-[#655BFF]/15">${cents / 100}</button>)}</div>
        <label className="block text-sm font-medium">Custom amount
          <div className="mt-2 flex items-center rounded-xl border border-white/15 bg-white/5 px-3"><span className="text-white/60">$</span><input value={custom} onChange={(e) => setCustom(e.target.value)} inputMode="decimal" placeholder="5–500" className="w-full bg-transparent px-2 py-3 outline-none" /></div>
        </label>
        <button type="button" onClick={chooseCustom} className="w-full rounded-full bg-[#655BFF] py-3 font-semibold">Review tip</button>
      </div>}
      {stage === "review" && <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-sm text-white/60">Tip amount</p><p className="mt-1 text-3xl font-semibold">${(amountCents / 100).toFixed(2)}</p></div>
        <p className="text-xs leading-5 text-white/55">CreatorNet’s platform fee is 12%. Payment-processing costs may be deducted separately from the creator’s share.</p>
        <div className="flex gap-2"><button type="button" onClick={() => setStage("amount")} className="flex-1 rounded-full border border-white/20 py-3">Back</button><button type="button" disabled={submitting} onClick={() => void startCheckout()} className="flex-1 rounded-full bg-[#655BFF] py-3 font-semibold disabled:opacity-50">{submitting ? "Starting…" : "Continue"}</button></div>
        {error && <button type="button" onClick={retry} className="w-full text-sm text-white/70 underline">Start a new tip</button>}
      </div>}
      {stage === "payment" && <div className="mt-6 space-y-4"><div ref={walletMount} aria-label="Express payment options" /><div ref={paymentMount} /><button type="button" disabled={submitting || !paymentReady} onClick={() => void confirmRef.current?.()} className="w-full rounded-full bg-[#655BFF] py-3 font-semibold disabled:opacity-50">{submitting ? "Confirming…" : `Tip $${(amountCents / 100).toFixed(2)}`}</button></div>}
      {stage === "processing" && <div className="py-10 text-center"><p className="text-lg font-semibold">Confirming your tip…</p><p className="mt-2 text-sm text-white/60">This is finalized securely by Stripe.</p></div>}
      {stage === "paid" && <div className="py-10 text-center"><p className="text-2xl font-semibold">Tip sent</p><p className="mt-2 text-white/60">You tipped {creatorName} ${(amountCents / 100).toFixed(2)}.</p><button type="button" onClick={close} className="mt-6 rounded-full bg-[#655BFF] px-8 py-3 font-semibold">Done</button></div>}
      {stage === "failed" && <div className="py-8 text-center"><p className="text-lg font-semibold">Tip not completed</p><button type="button" onClick={retry} className="mt-5 rounded-full bg-[#655BFF] px-8 py-3 font-semibold">Try again</button></div>}
      {stage === "canceled" && <div className="py-8 text-center"><p className="text-lg font-semibold">Tip canceled</p><p className="mt-2 text-sm text-white/60">No payment was completed.</p><button type="button" onClick={retry} className="mt-5 rounded-full bg-[#655BFF] px-8 py-3 font-semibold">Start a new tip</button></div>}
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    </section>
  </div>;
}
