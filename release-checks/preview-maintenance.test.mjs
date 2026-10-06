import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPreview, checkMaintenancePreview, maintenanceClosedGates } from './preview-credential-check.mjs';
import { diagnosePreview, diagnoseMaintenancePreview } from './preview-identity-diagnostic.mjs';
import { readPreviewRuntimeIdentity } from './preview-runtime-identity.mjs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const closed = [
  'CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY',
  'CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_OFFERS_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_SELECTOR_READY',
  'CREATOR_FIXED_SERVICE_OFFERS_READY',
  'CREATOR_FIXED_SERVICE_ONE_TIME_READY',
  'CREATOR_SERVER_PAYMENT_CARD_METHOD_READY',
  'CREATOR_SERVER_PAYMENT_REPLACEMENT_READY',
];
const context = {
  version: 'exact-payment-context-v1', mode: 'test',
  platformAccountId: 'acct_1SGnGAATzkMaGuMy', supabaseProjectRef: 'nwqfofezfzljhxolkycz',
  siteOrigin: 'https://creatornet-mvp-env-mentorship-sandbox-nrjimenez2-codes-projects.vercel.app',
};
const pin = {
  version: 'exact-context-pin-observation-v1', context,
  status: 'reserved_not_issuable', source: 'owner_provisioned_database_pin',
};
const urls = [
  'https://api.stripe.com/v1/account',
  'https://api.stripe.com/v1/balance',
  'https://nwqfofezfzljhxolkycz.supabase.co/rest/v1/rpc/read_exact_installment_context_pin_v2',
];
const runtimeOrigin = 'https://creatornet-fixture123-nrjimenez2-codes-projects.vercel.app';
const runtimeUrl = `${runtimeOrigin}/api/internal/mentorship-preview-identity`;
const gateNames = Object.keys(config.env).filter(name => /^CREATOR_.*_READY$/.test(name));
function runtimeEnvironment(authoring = false) {
  return {
    ...(authoring ? authoringEnvironment() : environment()),
    VERCEL_PROJECT_ID: 'prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA',
    VERCEL_URL: runtimeOrigin.slice('https://'.length),
    VERCEL_DEPLOYMENT_ID: 'dpl_fixture123',
  };
}

// All secrets here are inert fixtures. Tests inject responses and never use global fetch.
function environment() {
  return {
    ...config.env, VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'mentorship-sandbox',
    NEXT_PUBLIC_SITE_URL: context.siteOrigin,
    NEXT_PUBLIC_SUPABASE_URL: 'https://nwqfofezfzljhxolkycz.supabase.co',
    STRIPE_SECRET_KEY: 'sk_test_fixture', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture',
    R2_ACCOUNT_ID: 'fixture', R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture',
    R2_BUCKET_NAME: 'creatornet-media-staging',
    R2_PUBLIC_URL: 'https://pub-fc1b74a8d33c4f6cb7115e7eb0b73281.r2.dev',
  };
}
function authoringEnvironment() {
  const env = environment();
  for (const gate of closed) env[gate] = 'true';
  delete env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED;
  return env;
}
function responses() {
  return [{ object: 'account', id: context.platformAccountId }, { object: 'balance', livemode: false }, structuredClone(pin)];
}
function transport(bodies = responses(), override) {
  const calls = [];
  return {
    calls,
    async fetcher(url, options) {
      const index = calls.length;
      assert.equal(url, urls[index]);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ url, method: options.method, redirect: options.redirect });
      if (override) return override(index, bodies[index]);
      return Response.json(bodies[index]);
    },
  };
}
async function rejectsBeforeFetch(env) {
  const request = transport();
  await assert.rejects(checkMaintenancePreview(env, request.fetcher), /Preview identity check failed/);
  assert.equal(request.calls.length, 0);
}

test('maintenance preserves identity checks and reports only configured closure', async () => {
  const request = transport();
  const result = await checkMaintenancePreview(environment(), request.fetcher);
  assert.equal(request.calls.length, 3);
  assert.equal(result.accountId, context.platformAccountId);
  assert.deepEqual(result.context, context);
  assert.equal(result.admissionProfile, 'manual-payment-maintenance-v1');
  assert.deepEqual(result.configuredClosedGates, closed);
  assert.equal(result.newManualPaymentActionsPaused, true);
  for (const key of ['hostedAdmissionClosureVerified', 'providerDrainVerified', 'providerWrites',
    'databaseWrites', 'runtimeIdentityVerified', 'actualProviderFeesVerified', 'storageUploadVerified',
    'publishableKeyAccountBindingVerified']) assert.equal(result[key], false, key);
});
test('original authoring profile retains its successful contract', async () => {
  const request = transport();
  const result = await checkPreview(authoringEnvironment(), request.fetcher);
  assert.equal(request.calls.length, 3);
  assert.equal(result.version, 'sandbox-initial-payment-identity-v1');
  assert.equal(result.admissionProfile, undefined);
  assert.equal(result.configuredClosedGates, undefined);
  assert.equal(result.newManualPaymentActionsPaused, undefined);
});
test('original authoring profile rejects closed maintenance gates', async () => {
  const request = transport();
  await assert.rejects(checkPreview(environment(), request.fetcher));
  assert.equal(request.calls.length, 0);
});
test('root config keeps upstream jobs and disabled branch deployment alongside sandbox guard', () => {
  assert.deepEqual(config.crons, [
    { path: '/api/search/enrich', schedule: '*/10 * * * *' },
    { path: '/api/scheduling/google/jobs', schedule: '* * * * *' },
    { path: '/api/scheduling/google/sync', schedule: '* * * * *' },
    { path: '/api/scheduling/google/maintenance', schedule: '* * * * *' },
  ]);
  assert.equal(config.git.deploymentEnabled['feat/video-insights'], false);
  assert.equal(config.git.deploymentEnabled['codex/mentorship-maintenance-integration-20261005'], false);
  assert.equal(config.buildCommand, 'node release-checks/sandbox-target-check.mjs && node release-checks/preview-identity-diagnostic.mjs --maintenance && npm run build');
  assert.deepEqual(config.env, config.build.env);
  assert.deepEqual(maintenanceClosedGates, closed);
  assert.equal(config.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED, 'true');
  for (const gate of closed) assert.equal(config.env[gate], 'false', gate);
  assert.equal(config.env.CREATOR_MONTHLY_MENTORSHIPS_READY, 'false');
  assert.equal(config.env.CREATOR_MONTHLY_MENTORSHIPS_WORKER_READY, 'false');
  assert.equal(config.env.CREATOR_MENTORSHIP_INSTALLMENT_WORKER_READY, 'false');
});

for (const gate of closed) {
  test(`maintenance rejects reopened ${gate}`, async () => {
    await rejectsBeforeFetch({ ...environment(), [gate]: 'true' });
  });
}
for (const gate of [
  'CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY', 'CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY',
  'CREATOR_SERVER_PAYMENT_CONFIRMATION_READY', 'CREATOR_SERVER_PAYMENT_CANCELLATION_READY',
  'CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY', 'CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY', 'CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY',
  'CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY',
]) {
  test(`maintenance rejects disabled recovery prerequisite ${gate}`, async () => {
    await rejectsBeforeFetch({ ...environment(), [gate]: 'false' });
  });
}
const badSettings = [
  ['VERCEL_ENV', 'production'], ['VERCEL_TARGET_ENV', 'preview'],
  ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', 'false'], ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', undefined],
  ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', 'TRUE'],
  ['CREATOR_UNREVIEWED_FUTURE_PAYMENT_READY', 'true'],
  ['CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED', 'false'], ['CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT', 'true'],
  ['STRIPE_SECRET_KEY', 'sk_live_fixture'], ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_fixture'],
  ['SUPABASE_SERVICE_ROLE_KEY', ''], ['R2_ACCOUNT_ID', ''], ['R2_ACCESS_KEY_ID', ''], ['R2_SECRET_ACCESS_KEY', ''],
  ['NEXT_PUBLIC_SUPABASE_URL', 'https://wrong.invalid'], ['NEXT_PUBLIC_SITE_URL', 'https://wrong.invalid'],
  ['R2_BUCKET_NAME', 'production'], ['R2_PUBLIC_URL', 'https://wrong.invalid'],
  ['CREATOR_PROCESSING_FEE_ENABLED', 'false'], ['STRIPE_PROCESSING_FEE_BPS', '291'],
  ['STRIPE_PROCESSING_FEE_FIXED_CENTS', '31'], ['STRIPE_BILLING_FEE_BPS', '71'],
  ['STRIPE_PROCESSING_FEE_SCHEDULE_VERSION', 'other'],
  ['CREATOR_EXACT_INSTALLMENTS_CONTEXT', JSON.stringify({ ...context, mode: 'live' })],
];
for (const [key, value] of badSettings) {
  test(`maintenance rejects ${key}=${value === undefined ? 'unset' : value}`, async () => {
    const env = { ...environment(), [key]: value };
    if (value === undefined) delete env[key];
    await rejectsBeforeFetch(env);
  });
}
for (const [label, mutate] of [
  ['wrong account', bodies => { bodies[0].id = 'acct_other'; }],
  ['wrong account object', bodies => { bodies[0].object = 'customer'; }],
  ['live balance', bodies => { bodies[1].livemode = true; }],
  ['wrong balance object', bodies => { bodies[1].object = 'account'; }],
  ['pin context mismatch', bodies => { bodies[2].context.mode = 'live'; }],
  ['pin not reserved', bodies => { bodies[2].status = 'issuable'; }],
  ['unowned pin', bodies => { bodies[2].source = 'other'; }],
  ['unexpected pin field', bodies => { bodies[2].extra = true; }],
]) {
  test(`maintenance rejects observed ${label}`, async () => {
    const bodies = responses();
    mutate(bodies);
    const request = transport(bodies);
    await assert.rejects(checkMaintenancePreview(environment(), request.fetcher));
    assert.ok(request.calls.length > 0 && request.calls.length <= 3);
  });
}
for (const index of [0, 1, 2]) {
  test(`maintenance rejects non-JSON response ${index}`, async () => {
    const request = transport(responses(), (i, body) => i === index ? new Response('fixture', { headers: { 'content-type': 'text/plain' } }) : Response.json(body));
    await assert.rejects(checkMaintenancePreview(environment(), request.fetcher));
  });
  test(`maintenance rejects failed response ${index}`, async () => {
    const request = transport(responses(), (i, body) => Response.json(body, { status: i === index ? 503 : 200 }));
    await assert.rejects(checkMaintenancePreview(environment(), request.fetcher));
  });
}
test('diagnostic success uses chosen profile and only three read requests', async () => {
  const request = transport();
  const result = await diagnoseMaintenancePreview(environment(), request.fetcher);
  assert.equal(result.status, 'passed');
  assert.equal(result.proof.admissionProfile, 'manual-payment-maintenance-v1');
  assert.equal(request.calls.length, 3);
  const authoring = await diagnosePreview(authoringEnvironment(), transport().fetcher);
  assert.equal(authoring.status, 'passed');
  assert.equal(authoring.proof.admissionProfile, undefined);
});
test('diagnostic never forwards exception secrets or provider payload', async () => {
  const result = await diagnoseMaintenancePreview(environment(), async () => { throw Error('private_fixture_secret https://private.invalid'); });
  assert.deepEqual(result, { status: 'failed', stage: 'stripe_account_transport', httpStatus: null });
  const bodies = responses();
  bodies[0] = { object: 'account', id: 'private_fixture_secret' };
  const payload = await diagnoseMaintenancePreview(environment(), transport(bodies).fetcher);
  assert.deepEqual(payload, { status: 'failed', stage: 'stripe_account_check', httpStatus: 200 });
  assert.equal(JSON.stringify([result, payload]).includes('private_fixture_secret'), false);
});
for (const [vercelEnvironment, target, status] of [
  ['preview', 'mentorship-sandbox', 0], ['production', 'mentorship-sandbox', 1],
  ['preview', 'preview', 1], ['development', 'mentorship-sandbox', 1],
]) {
  test(`standalone guard: ${vercelEnvironment}/${target}`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./sandbox-target-check.mjs', import.meta.url))], {
      env: { VERCEL_ENV: vercelEnvironment, VERCEL_TARGET_ENV: target }, encoding: 'utf8',
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, status === 0 ? '' : 'Isolated sandbox target check failed\n');
  });
}
test('maintenance CLI rejects Production before any provider request', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./preview-identity-diagnostic.mjs', import.meta.url)), '--maintenance'], {
    env: { ...environment(), VERCEL_ENV: 'production' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', stage: 'deployment_environment', httpStatus: null });
  assert.equal(result.stderr, '');
});

test('maintenance runtime observes credentials with admission closed and no payment authority', async () => {
  const request = transport();
  const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), runtimeEnvironment(), gateNames, request.fetcher);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  const result = await response.json();
  assert.equal(result.version, 'sandbox-maintenance-runtime-identity-v1');
  assert.equal(result.deploymentId, 'dpl_fixture123');
  assert.equal(result.origin, runtimeOrigin);
  assert.equal(result.customEnvironment, 'mentorship-sandbox');
  assert.equal(result.runtimeCredentialIdentityVerified, true);
  assert.equal(result.databasePinVerified, true);
  assert.equal(result.paymentAuthorization, false);
  assert.equal(result.authorizationScope, 'manual_payment_maintenance_observation');
  assert.deepEqual(result.configuredClosedGates, closed);
  assert.equal(result.configuredAdmissionPaused, true);
  assert.equal(result.allReadinessGatesOff, false);
  assert.equal(result.gateCount, 230);
  assert.deepEqual(result.enabledGates, gateNames.filter(name => config.env[name] === 'true').sort());
  for (const key of ['exactPaymentContextVerified', 'actualPaymentAcceptanceVerified',
    'hostedAdmissionClosureVerified', 'providerDrainVerified']) assert.equal(result[key], false, key);
  for (const key of ['providerWrites', 'databaseWrites', 'actualProviderFeesVerified',
    'publishableKeyAccountBindingVerified', 'storageUploadVerified']) assert.equal(result.credentialObservation[key], false, key);
  assert.equal(request.calls.length, 3);
  assert.equal(JSON.stringify(result).includes('sk_test_fixture'), false);
  assert.equal(JSON.stringify(result).includes('pk_test_fixture'), false);
  assert.equal(JSON.stringify(result).includes('SUPABASE_SERVICE_ROLE_KEY'), false);
});

test('authoring runtime retains its original successful response', async () => {
  const request = transport();
  const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), runtimeEnvironment(true), gateNames, request.fetcher);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.version, 'sandbox-initial-payment-runtime-identity-v1');
  assert.equal(result.paymentAuthorization, true);
  assert.equal(result.authorizationScope, 'sandbox_initial_manual_full_and_first_installment');
  assert.equal(result.configuredAdmissionPaused, undefined);
  assert.equal(result.configuredClosedGates, undefined);
  assert.equal(result.credentialObservation.admissionProfile, undefined);
  assert.deepEqual(result.enabledGates, gateNames.filter(name => runtimeEnvironment(true)[name] === 'true').sort());
  assert.equal(result.actualPaymentAcceptanceVerified, false);
  assert.equal(request.calls.length, 3);
});

const runtimeBoundaryCases = [
  ['Production', { VERCEL_ENV: 'production' }, runtimeUrl],
  ['default Preview', { VERCEL_TARGET_ENV: 'preview' }, runtimeUrl],
  ['another project', { VERCEL_PROJECT_ID: 'prj_other' }, runtimeUrl],
  ['nonproject host', { VERCEL_URL: 'other.invalid' }, 'https://other.invalid/api/internal/mentorship-preview-identity'],
  ['missing deployment', { VERCEL_DEPLOYMENT_ID: undefined }, runtimeUrl],
  ['alias origin', {}, 'https://creatornet-mvp-env-mentorship-sandbox-nrjimenez2-codes-projects.vercel.app/api/internal/mentorship-preview-identity'],
  ['query selector', {}, `${runtimeUrl}?requestId=fixture`],
];
for (const [label, overrides, url] of runtimeBoundaryCases) {
  test(`runtime rejects ${label} before any provider read`, async () => {
    const request = transport();
    const response = await readPreviewRuntimeIdentity(new Request(url), { ...runtimeEnvironment(), ...overrides }, gateNames, request.fetcher);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
    assert.equal(request.calls.length, 0);
  });
}
test('runtime rejects a non-GET request before any provider read', async () => {
  const request = transport();
  const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl, { method: 'POST' }), runtimeEnvironment(), gateNames, request.fetcher);
  assert.equal(response.status, 404);
  assert.equal(request.calls.length, 0);
});

for (const [label, names] of [
  ['missing gate', gateNames.slice(1)],
  ['duplicate gate', [gateNames[0], ...gateNames.slice(0, -1)]],
  ['malformed gate', ['arbitrary', ...gateNames.slice(1)]],
]) {
  test(`runtime rejects ${label} manifest before any provider read`, async () => {
    const request = transport();
    const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), runtimeEnvironment(), names, request.fetcher);
    assert.equal(response.status, 503);
    assert.equal(request.calls.length, 0);
  });
}
for (const gate of closed) {
  test(`maintenance runtime refuses reopened ${gate}`, async () => {
    const request = transport();
    const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), { ...runtimeEnvironment(), [gate]: 'true' }, gateNames, request.fetcher);
    assert.equal(response.status, 503);
    assert.equal(request.calls.length, 0);
  });
}
for (const [key, value] of [
  ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', undefined],
  ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', 'false'],
  ['CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED', 'TRUE'],
  ['CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY', 'false'],
  ['CREATOR_SERVER_PAYMENT_CONFIRMATION_READY', 'false'],
  ['CREATOR_SERVER_PAYMENT_CANCELLATION_READY', 'false'],
  ['CREATOR_UNREVIEWED_FUTURE_PAYMENT_READY', 'true'],
  ['STRIPE_SECRET_KEY', 'sk_live_fixture'],
  ['NEXT_PUBLIC_SITE_URL', 'https://other.invalid'],
]) {
  test(`maintenance runtime refuses ${key}=${value === undefined ? 'unset' : value}`, async () => {
    const request = transport();
    const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), { ...runtimeEnvironment(), [key]: value }, gateNames, request.fetcher);
    assert.equal(response.status, 503);
    assert.equal(request.calls.length, 0);
  });
}
test('maintenance runtime redacts provider transport failures', async () => {
  let calls = 0;
  const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), runtimeEnvironment(), gateNames, async () => {
    calls += 1;
    throw Error('private_fixture_secret provider_body');
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Runtime identity requires review' });
  assert.equal(calls, 1);
});
for (const [label, mutate] of [
  ['wrong account', bodies => { bodies[0].id = 'acct_other'; }],
  ['LIVE mode', bodies => { bodies[1].livemode = true; }],
  ['changed database pin', bodies => { bodies[2].status = 'issuable'; }],
]) {
  test(`maintenance runtime refuses observed ${label}`, async () => {
    const bodies = responses();
    mutate(bodies);
    const request = transport(bodies);
    const response = await readPreviewRuntimeIdentity(new Request(runtimeUrl), runtimeEnvironment(), gateNames, request.fetcher);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Runtime identity requires review' });
    assert.ok(request.calls.length > 0 && request.calls.length <= 3);
  });
}
