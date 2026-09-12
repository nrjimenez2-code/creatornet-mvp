"use client";
import { useEffect, useRef, useState } from "react";
import type { MembershipRenewalRecoveryResult } from "@/lib/membershipRenewalRecovery";
type Props = { payment: MembershipRenewalRecoveryResult; onChecked: (payment: MembershipRenewalRecoveryResult) => void };
type Challenge = { status: "bank_verification_ready"; membershipId: string; invoiceId: string; month: number; amountCents: number;
  periodStart: number; periodEnd: number; publishableKey: string; clientSecret: string };
function same(value: Partial<MembershipRenewalRecoveryResult>, p: MembershipRenewalRecoveryResult) {
  return value.membershipId === p.membershipId && value.invoiceId === p.invoiceId && value.month === p.month &&
    value.amountCents === p.amountCents && value.periodStart === p.periodStart && value.periodEnd === p.periodEnd;
}
function challenge(value: unknown, p: MembershipRenewalRecoveryResult): Challenge {
  const c = value as Challenge;
  if (!c || typeof c !== "object" || c.status !== "bank_verification_ready" || !same(c, p) ||
    !/^pk_(test|live)_[A-Za-z0-9]+$/.test(c.publishableKey) || !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(c.clientSecret))
    throw Error("The original bank challenge could not be verified.");
  return c;
}
function receipt(value: unknown, p: MembershipRenewalRecoveryResult): MembershipRenewalRecoveryResult {
  const r = value as MembershipRenewalRecoveryResult;
  if (!r || typeof r !== "object" || !same(r, p) || !["payment_method_required", "action_required", "payment_pending",
    "terminal_unpaid", "paid_accounted", "review_required"].includes(r.outcome)) throw Error("The original payment receipt is not verified.");
  return r;
}
async function request(p: MembershipRenewalRecoveryResult, action: "challenge" | "status", signal: AbortSignal): Promise<unknown> {
  const response = await fetch("/api/memberships/" + p.membershipId + "/bank-verification", { method: "POST",
    credentials: "include", cache: "no-store", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, invoiceId: p.invoiceId }) });
  if (!response.ok) throw Error("Bank verification is unavailable. Check the original payment status or contact support.");
  return response.json();
}
/** The capability is kept only in this click handler and passed to Stripe.js.
 * It is never placed in React state, the DOM, a URL or browser storage. */
export default function MonthlyBankVerification({ payment, onChecked }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function verify() {
    if (inFlight.current || payment.outcome !== "action_required") return;
    inFlight.current = true; setBusy(true); setError(null);
    const c = new AbortController(); controller.current = c;
    try {
      const original = challenge(await request(payment, "challenge", c.signal), payment);
      if (c.signal.aborted) return;
      const { loadStripe } = await import("@stripe/stripe-js"), stripe = await loadStripe(original.publishableKey);
      if (c.signal.aborted) return;
      if (!stripe) throw Error("Secure bank verification could not load.");
      // No payment data or future-use options: authenticate only the payment
      // method already attached to this exact admitted PaymentIntent.
      const result = await stripe.confirmCardPayment(original.clientSecret);
      if (c.signal.aborted) return;
      const checked = receipt(await request(payment, "status", c.signal), payment);
      if (c.signal.aborted) return;
      onChecked(checked); // SDK success alone is never receipt/access authority.
      if (result.error && checked.outcome !== "paid_accounted")
        setError("Bank authentication was not completed. Check the original payment status before taking further action.");
    } catch {
      if (!c.signal.aborted) {
        try {
          const checked = receipt(await request(payment, "status", c.signal), payment);
          if (!c.signal.aborted) onChecked(checked);
        } catch { /* An uncertain status never triggers another payment. */ }
        if (!c.signal.aborted) setError("The original payment result is not confirmed here. Check payment status or contact support; do not start another purchase.");
      }
    } finally { inFlight.current = false; if (!c.signal.aborted) setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-white/20 p-4" aria-label="Original monthly payment bank verification">
    <p className="text-sm text-white/70">Your bank may open a verification dialog for this original monthly payment. This does not authorize another invoice or change your future-card choice.</p>
    <button type="button" disabled={busy || payment.outcome !== "action_required"} onClick={() => void verify()}
      className="rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-40">
      {busy ? "Checking the original bank payment..." : "Verify original payment with my bank"}</button>
    {busy && <p role="status">Complete your bank&apos;s verification. Do not submit another payment while this check is running.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
