import type Stripe from "stripe";
import { createHash } from "node:crypto";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import { buildBuyerMentorshipCheckoutRequest,inspectBuyerMentorshipUnpaidCheckout } from "@/lib/mentorshipInstallmentCheckout";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { installmentMonthBoundary } from "@/lib/installments/checkoutPreparation";
import { FIXED_PURCHASE_CONSENT_TEXT } from "@/lib/installments/purchaseConsent";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const anchor = Date.parse("2026-09-20T18:00:00Z") / 1000;
  const context = { version: "exact-payment-context-v1" as const, mode: "test" as const, platformAccountId: "acct_platform",
    supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://synthetic-mentorship.vercel.app" };
  const fees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" };
  const quote = mentorshipInstallmentQuote({ buyerId: id(1), postId: id(4), paymentCount: 3, firstPaymentFees: fees, renewalFees: fees,
    product: { id: id(3), creator_id: id(2), type: "mentorship", title: "Ten months of mentorship", price_cents: 10001,
      currency: "usd", fixed_service_months: 10, installment_options: [3] } });
  const reservation = { id: id(5), requestId: id(6), attemptId: id(7), buyerId: id(1), productId: id(3), postId: id(4),
    destinationId: "acct_creator", acceptedAt: new Date((anchor - 10) * 1000).toISOString(), ...quote,
    status: "reserved" as const, providerOperationsAllowed: false as const };
  const metadata = { creatornet_installment_version: quote.terms.installmentVersion, creatornet_installment_reservation_id: id(5),
    creatornet_installment_request_id: id(6), buyer_id: id(1), creator_id: id(2), product_id: id(3), post_id: id(4),
    terms_fingerprint: quote.fingerprint, payment_mode: "test", platform_account_id: "acct_platform",
    supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
  const customer = { object: "customer", id: "cus_owned", livemode: false, balance: 0, delinquent: false, default_source: null,
    invoice_settings: { default_payment_method: null }, test_clock: null, metadata: { ...metadata, operation_kind: "customer.create" } } as unknown as Stripe.Customer;
  const subscription = { object: "subscription", id: "sub_owned", livemode: false, customer: "cus_owned", status: "trialing",
    billing_mode: { type: "classic" }, trial_end: anchor + 48 * 3600, cancel_at: installmentMonthBoundary(anchor + 48 * 3600, 2),
    cancel_at_period_end: false, pause_collection: { behavior: "keep_as_draft" }, default_payment_method: null, default_source: null,
    application_fee_percent: null, transfer_data: { destination: "acct_creator" }, collection_method: "charge_automatically",
    automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [], pending_update: null, schedule: null, test_clock: null,
    metadata: { ...metadata, operation_kind: "subscription.create" },
    items: { has_more: false, data: [{ quantity: 1, tax_rates: [], discounts: [], price: { active: true, livemode: false, currency: "usd",
      product: "prod_owned", unit_amount: 3333, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] },
    payment_settings: { save_default_payment_method: "off", payment_method_types: ["card"] },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } } } as unknown as Stripe.Subscription;
  return { reservation, context, customer, subscription, nowSeconds: anchor + 60,
    dependencies: { customerId: "cus_owned", subscriptionId: "sub_owned", productId: "prod_owned", anchorSeconds: anchor },
    contextEvidence: { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
      observedPlatformAccountId: "acct_platform", observedSupabaseProjectRef: context.supabaseProjectRef,
      configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin } };
}
test("first payment preserves exact cents, fees and service duration independently of three installments", () => {
  const args = fixture(), before = JSON.stringify(args), request = buildBuyerMentorshipCheckoutRequest(args), p = request.params;
  expect(p.mode).toBe("payment"); expect(p.customer).toBe("cus_owned");
  expect(p.line_items?.[0].price_data?.unit_amount).toBe(3333);
  expect(p.payment_intent_data?.application_fee_amount).toBe(527);
  expect(p.payment_intent_data?.transfer_data?.destination).toBe("acct_creator");
  expect(p.payment_intent_data?.setup_future_usage).toBe("off_session");
  const submit = p.custom_text?.submit, message = submit && submit.message;
  expect(message).toContain("$33.33 today, then $33.33, $33.35");
  expect(message).toContain(FIXED_PURCHASE_CONSENT_TEXT);
  expect(message).toContain(args.reservation.terms.serviceDescription!);
  expect(p.consent_collection?.terms_of_service).toBe("required");
  expect(p.billing_address_collection).toBe("required");
  expect(p.customer_update).toEqual({ address: "auto" });
  expect(p.expires_at).toBe(args.dependencies.anchorSeconds + 24 * 3600);
  expect(p.metadata).toEqual(p.payment_intent_data?.metadata);
  expect(p.metadata).not.toHaveProperty("booking_id");
  expect(JSON.stringify(args)).toBe(before);
});
test.each(["customer", "destination", "subscription", "price product", "live mode", "hold", "resume", "trial", "stop", "tax", "discount", "saved card"])("rejects bootstrap drift: %s", field => {
  const args = fixture(), s = args.subscription;
  if (field === "customer") s.customer = "cus_other";
  if (field === "destination") s.transfer_data!.destination = "acct_other";
  if (field === "subscription") s.id = "sub_other";
  if (field === "price product") s.items.data[0].price.product = "prod_other";
  if (field === "live mode") s.livemode = true;
  if (field === "hold") s.pause_collection = null;
  if (field === "resume") s.pause_collection!.resumes_at = args.nowSeconds + 100;
  if (field === "trial") s.trial_end!++;
  if (field === "stop") s.cancel_at!++;
  if (field === "tax") s.automatic_tax.enabled = true;
  if (field === "discount") s.discounts = ["di_other"];
  if (field === "saved card") args.customer.invoice_settings.default_payment_method = "pm_other";
  expect(() => buildBuyerMentorshipCheckoutRequest(args)).toThrow();
});
test("recomputed hash cannot replace accepted fixed-total wording", () => {
  const args = fixture(); args.reservation.terms.fixedPurchaseConsentText = "Cancel anytime";
  args.reservation.fingerprint = createHash("sha256").update(JSON.stringify(args.reservation.terms)).digest("hex");
  expect(() => buildBuyerMentorshipCheckoutRequest(args)).toThrow();
});
test("correct-looking provider metadata cannot override independent account evidence", () => {
  const args = fixture(); args.contextEvidence.observedPlatformAccountId = "acct_other";
  expect(() => buildBuyerMentorshipCheckoutRequest(args)).toThrow();
});
test("a foreign request cannot reuse another accepted request's dedicated customer", () => {
  const args = fixture(); args.reservation.requestId = id(9);
  expect(() => buildBuyerMentorshipCheckoutRequest(args)).toThrow();
});
test("expired preparation cannot obtain a new checkout expiry by calling later", () => {
  const args = fixture(); args.nowSeconds = args.dependencies.anchorSeconds + 24 * 3600;
  expect(() => buildBuyerMentorshipCheckoutRequest(args)).toThrow();
});


test.each(["open","expired","expired with intent","paid","wrong amount","wrong customer","wrong redirect","wrong metadata","wrong request","future expiry","wrong session"])("original unpaid buyer Checkout observation: %s",scenario=>{
  const f=buyerFirstCaptureFixture(),p=f.originalRequest.params;
  const session={...f.data.session,status:"expired",payment_status:"unpaid",payment_intent:null,
    allow_promotion_codes:false,invoice_creation:{enabled:false},subscription:null,setup_intent:null,payment_link:null,recovered_from:null,
    success_url:p.success_url,cancel_url:p.cancel_url,payment_method_types:["card"],custom_text:p.custom_text,consent_collection:p.consent_collection} as unknown as Stripe.Checkout.Session;
  let nowSeconds=f.dependencies.anchorSeconds+86401;
  if(scenario==="open"){session.status="open";nowSeconds=f.nowSeconds;}
  if(scenario==="expired with intent")session.payment_intent="pi_owned";
  if(scenario==="paid")session.payment_status="paid";
  if(scenario==="wrong amount")session.amount_total=1;
  if(scenario==="wrong customer")session.customer="cus_foreign";
  if(scenario==="wrong redirect")session.success_url="https://other.invalid";
  if(scenario==="wrong metadata")session.metadata={};
  if(scenario==="wrong request")f.originalRequest.params.expires_at++;
  if(scenario==="future expiry")nowSeconds=f.nowSeconds;
  if(scenario==="wrong session")session.id="cs_test_other";
  const run=()=>inspectBuyerMentorshipUnpaidCheckout({...f,session,nowSeconds});
  if(["open","expired","expired with intent"].includes(scenario))expect(run()).toMatchObject({status:scenario==="open"?"open_unpaid":scenario==="expired"?"expired_without_payment_intent":"payment_reconciliation_required",releaseAllowed:false});
  else expect(run).toThrow();
});
