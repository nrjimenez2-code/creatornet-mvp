/* eslint-disable @typescript-eslint/no-require-imports -- This Node CLI is CommonJS so Jest and the deployment build use the same validator. */
const { isDeepStrictEqual } = require('node:util');

const PROFILE = 'original-monthly-completion-v1';
const PROJECT = 'prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA';
const CONTEXT = Object.freeze({
  apiVersion: '2025-10-29.clover', mode: 'test',
  stripeAccountId: 'acct_1SGnG1APff7wDYc9', supabaseProjectRef: 'nwqfofezfzljhxolkycz',
  siteOrigin: 'https://creatornet-mvp-git-admin-refun-9cbcbc-nrjimenez2-codes-projects.vercel.app',
});
const enabledGates = Object.freeze([
  'SCHEMA_READY', 'LEDGER_SCHEMA_READY', 'OPERATIONS_SCHEMA_READY', 'EVENTS_READY',
  'COLLECTION_SCHEMA_READY', 'PAYOFF_SCHEMA_READY', 'ACTIVATION_RECOVERY_SCHEMA_READY',
  'LIFECYCLE_SCHEMA_READY', 'LIFECYCLE_READY',
  'PAYMENT_EVENTS_SCHEMA_READY', 'PAYMENT_EVENTS_READY',
  'CHECKOUT_RECOVERY_SCHEMA_READY', 'CHECKOUT_RECOVERY_READY',
  'INITIAL_ABANDONMENT_SCHEMA_READY', 'INITIAL_ABANDONMENT_READY',
  'EXIT_SCHEMA_READY', 'EXIT_READY', 'EXIT_RECOVERY_SCHEMA_READY', 'EXIT_RECOVERY_READY',
  'MANAGEMENT_SCHEMA_READY', 'MANAGEMENT_READY',
].map(name => `CREATOR_MONTHLY_MENTORSHIPS_${name}`));
const allowed = new Set(enabledGates);
const gatePattern = /^CREATOR_[A-Z_]+_READY$/;
const readinessPattern = /^CREATOR_.*_READY$/;
const requireCheck = ok => { if (!ok) throw Error('Original monthly completion identity requires review'); };

function validateBindings(value) {
  requireCheck(Array.isArray(value) && value.length === 2);
  const ids = new Set();
  for (const binding of value) {
    requireCheck(binding && typeof binding === 'object' &&
      Object.keys(binding).sort().join(',') === 'fingerprint,id' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding.id) &&
      /^[0-9a-f]{64}$/.test(binding.fingerprint) && !ids.has(binding.id));
    ids.add(binding.id);
  }
  return value.map(binding => Object.freeze({ ...binding })).sort((a, b) => a.id.localeCompare(b.id));
}

// Produces a separate deployment configuration. The existing manual sandbox
// configuration and accepted database/provider contexts are never changed.
function prepareConfiguration(base, bindings) {
  const selected = validateBindings(bindings);
  requireCheck(base && typeof base.env === 'object' && !Array.isArray(base.env));
  const env = { ...base.env };
  for (const name of Object.keys(env)) if (readinessPattern.test(name)) env[name] = 'false';
  for (const name of enabledGates) {
    requireCheck(Object.hasOwn(base.env, name));
    env[name] = 'true';
  }
  Object.assign(env, {
    CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE: PROFILE,
    CREATOR_ORIGINAL_MONTHLY_COMPLETION_BINDINGS: JSON.stringify(selected),
    CREATOR_MONTHLY_MENTORSHIPS_CONTEXT: JSON.stringify(CONTEXT),
    CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED: 'true',
    CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: 'false',
    CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT: 'false',
    NEXT_PUBLIC_SITE_URL: CONTEXT.siteOrigin,
    NEXT_PUBLIC_SUPABASE_URL: `https://${CONTEXT.supabaseProjectRef}.supabase.co`,
  });
  return { ...base, env, crons: [], git: { deploymentEnabled: false },
    buildCommand: 'node release-checks/original-monthly-completion.cjs && npm run build' };
}

function validateConfiguration(env, gateNames) {
  requireCheck(env.VERCEL_ENV === 'preview' && env.VERCEL_TARGET_ENV === 'preview' &&
    env.VERCEL_PROJECT_ID === PROJECT && env.CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE === PROFILE);
  requireCheck(env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED === 'true' &&
    env.CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED === 'false' &&
    env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT === 'false' &&
    env.NEXT_PUBLIC_SITE_URL === CONTEXT.siteOrigin &&
    env.NEXT_PUBLIC_SUPABASE_URL === `https://${CONTEXT.supabaseProjectRef}.supabase.co` &&
    (!env.SUPABASE_URL || env.SUPABASE_URL === env.NEXT_PUBLIC_SUPABASE_URL));
  requireCheck(isDeepStrictEqual(JSON.parse(env.CREATOR_MONTHLY_MENTORSHIPS_CONTEXT || ''), CONTEXT));
  requireCheck(Array.isArray(gateNames) && gateNames.length === 230 && new Set(gateNames).size === 230 &&
    gateNames.every(name => gatePattern.test(name) && env[name] === (allowed.has(name) ? 'true' : 'false')) &&
    enabledGates.every(name => gateNames.includes(name)) &&
    Object.entries(env).every(([name, value]) => !readinessPattern.test(name) || value === (allowed.has(name) ? 'true' : 'false')));
  requireCheck(/^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') &&
    /^pk_test_[A-Za-z0-9]+$/.test(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '') &&
    typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' && env.SUPABASE_SERVICE_ROLE_KEY.length > 0);
  return validateBindings(JSON.parse(env.CREATOR_ORIGINAL_MONTHLY_COMPLETION_BINDINGS || ''));
}

// Each explicit invocation makes three bounded GETs, with no retries, provider
// mutations, locks, SDK initialization, or original financial-object replay.
// Build/runtime invocation needs its separately authorized fresh read scope.
async function checkIdentity(env, gateNames, fetcher = fetch) {
  const bindings = validateConfiguration(env, gateNames);
  const get = async (url, headers) => {
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    requireCheck(response.status === 200 && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') || ''));
    return response.json();
  };
  const stripeHeaders = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': CONTEXT.apiVersion };
  const account = await get('https://api.stripe.com/v1/account', stripeHeaders);
  requireCheck(account.object === 'account' && account.id === CONTEXT.stripeAccountId);
  const balance = await get('https://api.stripe.com/v1/balance', stripeHeaders);
  requireCheck(balance.object === 'balance' && balance.livemode === false);
  const query = new URL(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/monthly_mentorship_agreements_v1`);
  query.searchParams.set('select', 'id,fingerprint,context:terms->paymentContext');
  query.searchParams.set('id', `in.(${bindings.map(binding => binding.id).join(',')})`);
  query.searchParams.set('order', 'id.asc');
  query.searchParams.set('limit', '2');
  const rows = await get(query.href, { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });
  requireCheck(Array.isArray(rows) && rows.length === 2 && rows.every(row =>
    row && Object.keys(row).sort().join(',') === 'context,fingerprint,id' &&
    isDeepStrictEqual(row.context, CONTEXT)) &&
    isDeepStrictEqual(rows.map(({ id, fingerprint }) => ({ id, fingerprint })), bindings));
  return { version: PROFILE, observedAt: new Date().toISOString(), context: { ...CONTEXT },
    enabledGates: [...enabledGates], configuredNewAdmissionClosed: true,
    originalAgreementPinCount: bindings.length, originalAgreementContextsVerified: true,
    serverCredentialAccountAndModeVerified: true, publishableKeyAccountBindingVerified: false,
    schemaCompatibilityVerified: false, signedDeliveryVerified: false,
    hostedAdmissionClosureVerified: false, providerDrainVerified: false,
    paymentAuthorization: false, providerWrites: false, databaseWrites: false,
    actualPaymentAcceptanceVerified: false };
}

async function readRuntimeIdentity(request, env, gateNames, fetcher = fetch) {
  const reply = (body, status) => Response.json(body, { status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } });
  try {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.search || url.pathname !== '/api/internal/mentorship-original-monthly-identity' ||
      !/^creatornet-[a-z0-9]+-nrjimenez2-codes-projects\.vercel\.app$/.test(env.VERCEL_URL || '') ||
      url.origin !== `https://${env.VERCEL_URL}` || !/^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID || ''))
      return reply({ error: 'Not found' }, 404);
    const proof = await checkIdentity(env, gateNames, fetcher);
    return reply({ ...proof, deploymentId: env.VERCEL_DEPLOYMENT_ID, origin: url.origin }, 200);
  } catch { return reply({ error: 'Original monthly completion identity requires review' }, 503); }
}

module.exports = { PROFILE, CONTEXT, enabledGates, prepareConfiguration, validateConfiguration, checkIdentity, readRuntimeIdentity };
if (require.main === module) {
  const base = require('../vercel.json');
  checkIdentity(process.env, Object.keys(base.env).filter(name => gatePattern.test(name)))
    .then(proof => console.log(JSON.stringify(proof)))
    .catch(() => { console.error('Original monthly completion identity requires review; build stopped.'); process.exitCode = 1; });
}
