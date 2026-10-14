jest.mock('server-only', () => ({}));
import { membershipCheckoutReady, membershipServerContext } from '@/lib/membershipServer';
import { membershipInitialAbandonmentReady } from '@/lib/membershipInitialAbandonment';
import { membershipCheckoutRecoveryReady } from '@/lib/membershipCheckoutRecovery';
import { membershipExitReady } from '@/lib/membershipExit';
import { membershipManagementReady } from '@/lib/membershipManagement';
import { membershipLifecycleReady } from '@/lib/membershipLifecycle';
import { membershipPaymentEventsReady } from '@/lib/membershipPaymentEvents';
import { membershipPayoffCheckoutReady, membershipPayoffReconciliationReady } from '@/lib/membershipPayoffRuntime';
import { purchasePoliciesActive } from '@/lib/purchasePolicies';
import completion from '../release-checks/original-monthly-completion.cjs';
import base from '../vercel.json';

const fixtureBindings = [
  { id: '10000000-0000-4000-8000-000000000001', fingerprint: '1'.repeat(64) },
  { id: '10000000-0000-4000-8000-000000000002', fingerprint: '2'.repeat(64) },
];
const prepared = completion.prepareConfiguration(base, fixtureBindings);
const env: Record<string, string> = { ...prepared.env, VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview',
  VERCEL_PROJECT_ID: 'prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA',
  STRIPE_SECRET_KEY: 'sk_test_fixture', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture' };

test('original completion keeps the actual monthly service paths available with purchase admission closed', () => {
  expect(membershipServerContext(env)).toEqual(completion.CONTEXT);
  expect(membershipCheckoutReady(env)).toBe(false);
  expect(membershipPayoffCheckoutReady(env)).toBe(false);
  expect(env.CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY).toBe('true');
  expect(purchasePoliciesActive(env)).toBe(false);
  for (const available of [membershipInitialAbandonmentReady, membershipCheckoutRecoveryReady,
    membershipExitReady, membershipManagementReady, membershipLifecycleReady,
    membershipPaymentEventsReady, membershipPayoffReconciliationReady]) expect(available(env)).toBe(true);
  for (const gate of ['BILLING_READY', 'RENEWALS_READY', 'WORKER_READY', 'RETRY_READY',
    'CARD_SETUP_READY', 'CHECKOUT_READY', 'PAYOFF_READY']) expect(env[`CREATOR_MONTHLY_MENTORSHIPS_${gate}`]).toBe('false');
  expect(prepared.crons).toEqual([]);
});

test('preparing the original profile preserves the separate manual sandbox configuration', () => {
  expect(JSON.parse(base.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT).siteOrigin).not.toBe(completion.CONTEXT.siteOrigin);
  expect(base.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT).toContain('acct_1SGnGAATzkMaGuMy');
  expect(prepared.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT).toBe(base.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT);
  expect(prepared.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY).toBe('false');
  expect(prepared.env.CREATOR_MONTHLY_MENTORSHIPS_CONTEXT).toContain('acct_1SGnG1APff7wDYc9');
});
