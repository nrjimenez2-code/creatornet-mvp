/* eslint-disable @typescript-eslint/no-require-imports -- Native Node tests exercise the CommonJS build entry point. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { PROFILE, CONTEXT, enabledGates, prepareConfiguration, validateConfiguration,
  checkIdentity, readRuntimeIdentity } = require('./original-monthly-completion.cjs');
const base = require('../vercel.json');
const bindings = [
  { id: '10000000-0000-4000-8000-000000000001', fingerprint: '1'.repeat(64) },
  { id: '10000000-0000-4000-8000-000000000002', fingerprint: '2'.repeat(64) },
];
const names = Object.keys(base.env).filter(name => /^CREATOR_[A-Z_]+_READY$/.test(name));
const prepared = prepareConfiguration(base, bindings);
const origin = 'https://creatornet-fixture123-nrjimenez2-codes-projects.vercel.app';
const runtimeUrl = `${origin}/api/internal/mentorship-original-monthly-identity`;
const environment = overrides => ({ ...prepared.env, VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview',
  VERCEL_PROJECT_ID: 'prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA', VERCEL_URL: origin.slice(8),
  VERCEL_DEPLOYMENT_ID: 'dpl_fixture123', STRIPE_SECRET_KEY: 'sk_test_fixture',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture_database_secret',
  ...overrides });
const bodies = () => [
  { object: 'account', id: CONTEXT.stripeAccountId }, { object: 'balance', livemode: false },
  bindings.map(binding => ({ ...binding, context: { ...CONTEXT } })),
];
function transport(replies = bodies(), responseFor) {
  const calls = [];
  return { calls, async fetcher(url, options) {
    const index = calls.length;
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (index < 2) {
      assert.equal(url, `https://api.stripe.com/v1/${index ? 'balance' : 'account'}`);
      assert.equal(options.headers['Stripe-Version'], CONTEXT.apiVersion);
    } else {
      const query = new URL(url);
      assert.equal(query.origin, `https://${CONTEXT.supabaseProjectRef}.supabase.co`);
      assert.equal(query.pathname, '/rest/v1/monthly_mentorship_agreements_v1');
      assert.equal(query.searchParams.get('select'), 'id,fingerprint,context:terms->paymentContext');
      assert.equal(query.searchParams.get('id'), `in.(${bindings.map(binding => binding.id).join(',')})`);
      assert.equal(query.searchParams.get('order'), 'id.asc'); assert.equal(query.searchParams.get('limit'), '2');
      assert.equal(query.searchParams.size, 4);
    }
    assert.ok(index < 3, 'No retries or extra provider/database calls');
    calls.push({ url, method: options.method });
    return responseFor ? responseFor(index) : Response.json(replies[index]);
  } };
}

test('separate configuration closes inherited admission and leaves the original configuration untouched', () => {
  const original = JSON.stringify(base);
  const config = prepareConfiguration(base, [...bindings].reverse());
  assert.equal(JSON.stringify(base), original);
  assert.equal(config.env.CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE, PROFILE);
  assert.deepEqual(JSON.parse(config.env.CREATOR_MONTHLY_MENTORSHIPS_CONTEXT), CONTEXT);
  assert.equal(config.env.NEXT_PUBLIC_SITE_URL, CONTEXT.siteOrigin);
  assert.deepEqual(config.crons, []); assert.deepEqual(config.git, { deploymentEnabled: false });
  const generatedNames = Object.keys(config.env).filter(name => /^CREATOR_[A-Z_]+_READY$/.test(name));
  assert.deepEqual(generatedNames, names);
  assert.deepEqual(names.filter(name => config.env[name] === 'true').sort(), [...enabledGates].sort());
  assert.deepEqual(validateConfiguration(environment(), generatedNames), bindings);
});

test('build environment uses the original completion profile and its closed admission gates', async () => {
  const config = prepareConfiguration(base, bindings);
  const buildEnvironment = { ...environment(), ...config.build.env };
  assert.deepEqual(validateConfiguration(buildEnvironment, names), bindings);
  assert.equal(buildEnvironment.CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED, 'false');
  assert.equal(buildEnvironment.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED, 'true');
  for (const [name, value] of Object.entries(config.env)) assert.equal(config.build.env[name], value);
  const request = transport();
  const proof = await checkIdentity(buildEnvironment, names, request.fetcher);
  assert.equal(request.calls.length, 3);
  assert.equal(proof.originalAgreementContextsVerified, true);
  assert.equal(proof.paymentAuthorization, false);
});

test('build environment preserves unrelated settings and closes inherited build-only readiness', () => {
  const inherited = { ...base, build: { ...base.build, customBuildOption: 'preserved', env: {
    ...base.build.env, BUILD_ONLY_OPTION: 'preserved', CREATOR_BUILD_ONLY_READY: 'true',
  } } };
  const original = JSON.stringify(inherited);
  const config = prepareConfiguration(inherited, bindings);
  assert.equal(JSON.stringify(inherited), original);
  assert.equal(config.build.customBuildOption, 'preserved');
  assert.equal(config.build.env.BUILD_ONLY_OPTION, 'preserved');
  assert.equal(config.build.env.CREATOR_BUILD_ONLY_READY, 'false');
  assert.notEqual(config.build, inherited.build);
  assert.notEqual(config.build.env, inherited.build.env);
  assert.deepEqual(validateConfiguration({ ...environment(), ...config.build.env }, names), bindings);
});

test('identity proof uses only the original account, TEST mode and two sealed stored context projections', async () => {
  const request = transport(); const proof = await checkIdentity(environment(), names, request.fetcher);
  assert.equal(request.calls.length, 3); assert.equal(proof.originalAgreementContextsVerified, true);
  assert.equal(proof.serverCredentialAccountAndModeVerified, true);
  for (const field of ['schemaCompatibilityVerified', 'signedDeliveryVerified', 'hostedAdmissionClosureVerified',
    'providerDrainVerified', 'paymentAuthorization', 'providerWrites', 'databaseWrites', 'actualPaymentAcceptanceVerified'])
    assert.equal(proof[field], false);
  const result = JSON.stringify(proof);
  for (const forbidden of ['sk_test_fixture', 'fixture_database_secret', bindings[0].id, bindings[0].fingerprint])
    assert.equal(result.includes(forbidden), false);
});

for (const [label, overrides] of [
  ['Production', { VERCEL_ENV: 'production' }],
  ['distinct manual target', { VERCEL_TARGET_ENV: 'mentorship-sandbox' }],
  ['wrong project', { VERCEL_PROJECT_ID: 'prj_other' }],
  ['manual origin', { NEXT_PUBLIC_SITE_URL: base.env.NEXT_PUBLIC_SITE_URL }],
  ['wrong database', { NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co' }],
  ['alternate database URL', { SUPABASE_URL: 'https://other.supabase.co' }],
  ['LIVE key', { STRIPE_SECRET_KEY: 'sk_live_fixture' }],
  ['LIVE publishable key', { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture' }],
  ['absent database credential', { SUPABASE_SERVICE_ROLE_KEY: '' }],
  ['unpaused manual actions', { CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED: 'false' }],
  ['policy activation', { CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: 'true' }],
  ['renewal billing', { CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY: 'true' }],
  ['new checkout', { CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_READY: 'true' }],
  ['new payoff', { CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY: 'true' }],
  ['unknown enabled gate', { CREATOR_UNKNOWN_V2_READY: 'true' }],
  ['disabled completion gate', { CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY: 'false' }],
  ['disabled original activation observation', { CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY: 'false' }],
  ['different accepted context', { CREATOR_MONTHLY_MENTORSHIPS_CONTEXT: JSON.stringify({ ...CONTEXT, stripeAccountId: 'acct_other' }) }],
  ['unbound originals', { CREATOR_ORIGINAL_MONTHLY_COMPLETION_BINDINGS: '[]' }],
]) test(`rejects ${label} before any provider/database request`, async () => {
  const request = transport(); await assert.rejects(checkIdentity(environment(overrides), names, request.fetcher));
  assert.equal(request.calls.length, 0);
});

for (const [label, mutate, expectedCalls] of [
  ['manual sandbox account', data => { data[0].id = 'acct_1SGnGAATzkMaGuMy'; }, 1],
  ['LIVE balance', data => { data[1].livemode = true; }, 2],
  ['missing stored original', data => { data[2].pop(); }, 3],
  ['changed fingerprint', data => { data[2][0].fingerprint = '3'.repeat(64); }, 3],
  ['changed original context', data => { data[2][0].context.siteOrigin = base.env.NEXT_PUBLIC_SITE_URL; }, 3],
  ['duplicate stored owner', data => { data[2][1] = data[2][0]; }, 3],
]) test(`fails closed on ${label} with no retry`, async () => {
  const data = bodies(); mutate(data); const request = transport(data);
  await assert.rejects(checkIdentity(environment(), names, request.fetcher)); assert.equal(request.calls.length, expectedCalls);
});

for (const [label, responseFor] of [
  ['redirect', () => new Response('', { status: 302, headers: { location: 'https://other.test' } })],
  ['unavailable provider', () => Response.json({}, { status: 503 })],
  ['non-JSON response', () => new Response('secret error details', { status: 200 })],
  ['network uncertainty', () => { throw Error('secret error details'); }],
]) test(`runtime suppresses ${label} and does not retry`, async () => {
  const request = transport(undefined, responseFor);
  const response = await readRuntimeIdentity(new Request(runtimeUrl), environment(), names, request.fetcher);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Original monthly completion identity requires review' });
  assert.equal(request.calls.length, 1);
});

test('runtime is confined to the exact generated deployment host and GET path', async () => {
  for (const request of [new Request(runtimeUrl + '?extra=1'), new Request(runtimeUrl, { method: 'POST' }),
    new Request(CONTEXT.siteOrigin + '/api/internal/mentorship-original-monthly-identity'), new Request(origin + '/other')]) {
    const transportRequest = transport();
    const response = await readRuntimeIdentity(request, environment(), names, transportRequest.fetcher);
    assert.equal(response.status, 404); assert.equal(transportRequest.calls.length, 0);
  }
  const request = transport();
  const response = await readRuntimeIdentity(new Request(runtimeUrl), environment(), names, request.fetcher);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).deploymentId, 'dpl_fixture123');
});

test('missing, duplicate or malformed readiness inventory fails before reads', async () => {
  for (const inventory of [names.slice(1), [names[0], ...names.slice(0, -1)], ['arbitrary', ...names.slice(1)]]) {
    const request = transport(); await assert.rejects(checkIdentity(environment(), inventory, request.fetcher));
    assert.equal(request.calls.length, 0);
  }
});

test('CLI configuration failure emits a fixed diagnostic without network or secret output', () => {
  const result = spawnSync(process.execPath, [require.resolve('./original-monthly-completion.cjs')], {
    env: { PATH: process.env.PATH, VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_never_log_this' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Original monthly completion identity requires review; build stopped.');
});
