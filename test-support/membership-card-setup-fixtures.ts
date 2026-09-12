import type Stripe from "stripe";
import { membershipRenewalFixture } from "./membership-renewal-fixtures";
import { monthlyCardSetupParams, type MonthlyCardSetup } from "@/lib/membershipCardSetup";
import { MONTHLY_CARD_SETUP_CONSENT_TEXT, MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
export function monthlyCardSetupFixture() {
  const f = membershipRenewalFixture(), now = Math.floor(Date.now() / 1000);
  const r: MonthlyCardSetup = { id: "20000000-0000-4000-8000-000000000001", operation_id: "20000000-0000-4000-8000-000000000002",
    agreement_id: f.a.id, buyer_id: f.a.buyer_id, snapshot: { membershipId: f.a.id, operationId: "20000000-0000-4000-8000-000000000002",
      invoiceId: f.invoice.id, paymentIntentId: f.paymentIntent.id, customerId: f.customer.id, subscriptionId: f.subscription.id,
      originalPaymentMethodId: "pm_fixture", monthlyPriceCents: f.a.monthly_price_cents, periodStart: f.period.start, periodEnd: f.period.end,
      revision: f.a.revision, fingerprint: f.a.fingerprint, paymentContext: f.a.terms.paymentContext },
    consent_version: MONTHLY_CARD_SETUP_CONSENT_VERSION, consent_text: MONTHLY_CARD_SETUP_CONSENT_TEXT,
    created_at: now, expires_at: now + 3600, request: {}, dispatch_started_at: null,
    session_id: null, setup_intent_id: null, payment_method_id: null, verified_at: null, closed_at: null };
  r.request = monthlyCardSetupParams(r);
  const session = () => ({ ...r.request, id: "cs_test_cardsetup", object: "checkout.session", created: Math.floor(Date.now() / 1000),
    customer: f.customer.id, livemode: false, payment_status: "no_payment_required", amount_total: null, amount_subtotal: null,
    payment_intent: null, subscription: null, invoice: null, setup_intent: null, status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_cardsetup" }) as unknown as Stripe.Checkout.Session;
  const intent = () => ({ id: "seti_cardsetup", object: "setup_intent", customer: f.customer.id, payment_method: "pm_replacement", livemode: false,
    status: "succeeded", usage: "off_session", on_behalf_of: null, created: r.created_at, payment_method_types: ["card"], metadata: r.request.metadata }) as unknown as Stripe.SetupIntent;
  const card = { id: "pm_replacement", object: "payment_method", customer: f.customer.id, type: "card", livemode: false } as Stripe.PaymentMethod;
  return { f, r, session, intent, card };
}

