import { isDeepStrictEqual } from 'node:util';
const expectedContext = {"version": "exact-payment-context-v1", "mode": "test", "platformAccountId": "acct_1SGnGAATzkMaGuMy", "supabaseProjectRef": "nwqfofezfzljhxolkycz", "siteOrigin": "https://creatornet-mvp-env-mentorship-sandbox-nrjimenez2-codes-projects.vercel.app"};
const expectedSettings = {"CREATOR_EXACT_INSTALLMENTS_CONTEXT": "{\"version\":\"exact-payment-context-v1\",\"mode\":\"test\",\"platformAccountId\":\"acct_1SGnGAATzkMaGuMy\",\"supabaseProjectRef\":\"nwqfofezfzljhxolkycz\",\"siteOrigin\":\"https://creatornet-mvp-env-mentorship-sandbox-nrjimenez2-codes-projects.vercel.app\"}", "CREATOR_PROCESSING_FEE_ENABLED": "true", "STRIPE_PROCESSING_FEE_BPS": "290", "STRIPE_PROCESSING_FEE_FIXED_CENTS": "30", "STRIPE_BILLING_FEE_BPS": "70", "STRIPE_PROCESSING_FEE_SCHEDULE_VERSION": "stripe-standard-us-2026-09-03"};
import { pathToFileURL } from 'node:url';

const authoringGates = new Set(["CREATOR_SERVER_PAYMENT_CARD_METHOD_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_CARD_METHOD_READY", "CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY", "CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY", "CREATOR_FIXED_SERVICE_CONTEXT_READY", "CREATOR_FIXED_SERVICE_OFFERS_READY", "CREATOR_FIXED_SERVICE_ONE_TIME_READY", "CREATOR_FIXED_SERVICE_SCHEMA_READY", "CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY", "CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY", "CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY", "CREATOR_FULL_MANUAL_DISCOVERY_SCHEMA_READY", "CREATOR_FULL_REFUND_EVENT_SCHEMA_READY", "CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY", "CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_READY", "CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY", "CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_DISPUTE_READY", "CREATOR_FULL_SERVER_PAYMENT_DISPUTE_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_READY", "CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_LIFECYCLE_READY", "CREATOR_FULL_SERVER_PAYMENT_RECEIPT_INSPECTION_READY", "CREATOR_FULL_SERVER_PAYMENT_RECEIPT_RECORD_READY", "CREATOR_FULL_SERVER_PAYMENT_RECEIPT_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_REFUND_READY", "CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY", "CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY", "CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY", "CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY", "CREATOR_FULL_SERVER_REFUND_OBJECT_READY", "CREATOR_FULL_SERVER_REFUND_OBJECT_SCHEMA_READY", "CREATOR_FULL_UNCLAIMED_RELEASE_READY", "CREATOR_FULL_UNRESERVED_RELEASE_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_ACTIONS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_EXECUTOR_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_OPERATIONS_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_PROOF_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_UI_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ACCESS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_READY", "CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_OBSERVATION_READY", "CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY", "CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_READY", "CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY", "CREATOR_MENTORSHIP_INSTALLMENT_DISCOVERY_READY", "CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_RECOVERY_READY", "CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY", "CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_MANAGEMENT_READY", "CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY", "CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY", "CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY", "CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_OFFERS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_OPTIONS_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_READY", "CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_READY", "CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_INSPECTION_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY", "CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY", "CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY", "CREATOR_MENTORSHIP_INSTALLMENT_SELECTOR_READY", "CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY", "CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_SCHEMA_READY", "CREATOR_MENTORSHIP_MANUAL_CHECKOUT_UI_READY", "CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY", "CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY", "CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY", "CREATOR_PURCHASE_CONSENT_SCHEMA_READY", "CREATOR_PURCHASE_POLICIES_READY", "CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY", "CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY", "CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_CANCELLATION_READY", "CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_CONFIRMATION_READY", "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_INTENT_READY", "CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_RECEIPT_INSPECTION_READY", "CREATOR_SERVER_PAYMENT_RECEIPT_READY", "CREATOR_SERVER_PAYMENT_RECEIPT_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_REPLACEMENT_READY", "CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY"]);

export const maintenanceClosedGates = Object.freeze([
  'CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY',
  'CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_OFFERS_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_SELECTOR_READY',
  'CREATOR_FIXED_SERVICE_OFFERS_READY',
  'CREATOR_FIXED_SERVICE_ONE_TIME_READY',
  'CREATOR_SERVER_PAYMENT_CARD_METHOD_READY',
  'CREATOR_SERVER_PAYMENT_REPLACEMENT_READY',
]);
const maintenanceGates = new Set([...authoringGates].filter(key => !maintenanceClosedGates.includes(key)));

// The original authoring profile retains its exact identity/readiness checks.
export async function checkPreview(env, fetcher = fetch) {
  return checkProfile(env, fetcher, false);
}
export async function checkMaintenancePreview(env, fetcher = fetch) {
  return checkProfile(env, fetcher, true);
}

// Build-only preflight. No SDK initialization, writes, redirects or response-body logs.
async function checkProfile(env, fetcher, maintenance) {
  const require = (ok) => { if (!ok) throw new Error('Preview identity check failed'); };
  require(env.VERCEL_ENV === 'preview');
  require(env.CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED === 'true' && env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT === 'false');
  require(env.R2_BUCKET_NAME === 'creatornet-media-staging');
  require(env.R2_PUBLIC_URL === 'https://pub-fc1b74a8d33c4f6cb7115e7eb0b73281.r2.dev');
  require(['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(k=>typeof env[k] === 'string' && env[k].length > 0));
  require(Object.entries(expectedSettings).every(([k,v]) => env[k] === v));
  require(env.NEXT_PUBLIC_SITE_URL === expectedContext.siteOrigin);
  require(env.NEXT_PUBLIC_SUPABASE_URL === 'https://nwqfofezfzljhxolkycz.supabase.co');
  require(/^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? ''));
  require(/^pk_test_[A-Za-z0-9]+$/.test(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''));
  require(!!env.SUPABASE_SERVICE_ROLE_KEY);
  if (maintenance) {
    require(env.VERCEL_TARGET_ENV === 'mentorship-sandbox');
    require(env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED === 'true');
    require(maintenanceClosedGates.every(key => env[key] === 'false'));
  }
  const requiredGates = maintenance ? maintenanceGates : authoringGates;
  require([...requiredGates].every(k => env[k] === 'true'));
  require(Object.entries(env).every(([k,v]) => !/^CREATOR_.*_READY$/.test(k) || v === (requiredGates.has(k) ? 'true' : 'false')));
  async function get(url, headers) {
    const r = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    require(r.ok && /^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? ''));
    return r.json();
  }
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2025-10-29.clover' };
  const account = await get('https://api.stripe.com/v1/account', headers);
  require(account.object === 'account' && account.id === 'acct_1SGnGAATzkMaGuMy');
  const balance = await get('https://api.stripe.com/v1/balance', headers);
  require(balance.object === 'balance' && balance.livemode === false);
  const pinResponse = await fetcher('https://nwqfofezfzljhxolkycz.supabase.co/rest/v1/rpc/read_exact_installment_context_pin_v2', {
    method:'GET', redirect:'error', signal:AbortSignal.timeout(10000), headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  require(pinResponse.status === 200 && /^application\/json(?:;|$)/i.test(pinResponse.headers.get('content-type') ?? ''));
  const pin = await pinResponse.json();
  require(isDeepStrictEqual(pin, {version:'exact-context-pin-observation-v1',context:expectedContext,status:'reserved_not_issuable',source:'owner_provisioned_database_pin'}));
  return { version: 'sandbox-initial-payment-identity-v1', observedAt: new Date().toISOString(),
    accountId: account.id, mode: 'test', supabaseProjectRef: 'nwqfofezfzljhxolkycz',
    contextPinState: 'matching_owner_pin', contextPinVerified: true, context: expectedContext,
    configuredFeeSchedule: {basisPoints:290,fixedCents:30,billingBasisPoints:70,version:'stripe-standard-us-2026-09-03'}, actualProviderFeesVerified:false,
    storageBucket:'creatornet-media-staging', storageOrigin:'https://pub-fc1b74a8d33c4f6cb7115e7eb0b73281.r2.dev', storageUploadVerified:false,
    providerWrites: false, databaseWrites: false, runtimeIdentityVerified: false,
    publishableKeyAccountBindingVerified: false,
    ...(maintenance ? {admissionProfile:'manual-payment-maintenance-v1',configuredClosedGates:[...maintenanceClosedGates],
      newManualPaymentActionsPaused:true,hostedAdmissionClosureVerified:false,providerDrainVerified:false} : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkPreview(process.env))); }
  catch { console.error('Preview identity check failed; build stopped. No credentials or response bodies logged.'); process.exitCode = 1; }
}
