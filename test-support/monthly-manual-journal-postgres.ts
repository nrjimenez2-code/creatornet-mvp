import type {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';

/** Minimal monthly structural dependencies for focused journal behavior tests.
 * The complete production composition/access rehearsal is separate evidence.
 * No hosted data, receipt, admission or provider request is manufactured. */
export async function installMonthlyManualJournal(db:PGlite, options:{terminalRelease?:boolean}={}){
  await db.exec(`create unique index journal_profiles_id on profiles(id);
    create table monthly_mentorship_agreements_v1(id uuid primary key,purchase_id uuid,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      terms jsonb,fingerprint text,accepted_at timestamptz,monthly_price_cents bigint,minimum_months int,auto_renew boolean,
      revision int,covered_months int,anchor_at bigint,stripe_customer_id text,stripe_subscription_id text,stripe_checkout_session_id text,
      financial_hold_at timestamptz,renewal_stopped_at timestamptz,debit_revoked_at timestamptz,billing_review_at timestamptz,
      initial_abandon_requested_at timestamptz,initial_abandoned_at timestamptz,payoff_hold_at timestamptz);
    create table monthly_mentorship_operations_v1(agreement_id uuid,kind text,scope_key text,request jsonb,status text,provider_id text,
      unique(agreement_id,kind,scope_key));
    create table monthly_mentorship_receipts_v1(agreement_id uuid,month_number int);
    create table payment_fee_ledger(purchase_id uuid,stripe_payment_intent_id text);
    create table monthly_mentorship_initial_closures_v1(agreement_id uuid);
    create table monthly_mentorship_payoffs_v1(id uuid primary key,agreement_id uuid,buyer_id uuid,terms jsonb,fingerprint text,
      amount_cents bigint,remaining_months int,first_unpaid_month int,period_start bigint,period_end bigint,accepted_at timestamptz,
      status text,checkout_request jsonb,checkout_dispatched_at timestamptz,stripe_checkout_session_id text,checkout_request_id text,
      ledger_id uuid,provider_proof jsonb,captured_at timestamptz,abandoned_at timestamptz,abandonment_proof jsonb);`);
  for(const f of ['20260925052000_monthly_manual_payment_selection.sql','20260925060000_monthly_manual_intent_source.sql',
    '20260925062000_monthly_manual_cancellation_source.sql'])
    await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
  if(options.terminalRelease){
    // Install the actual monthly retirement writer against focused structural
    // dependencies. Its full-schema compatibility is rehearsed separately.
    await db.exec(`alter table monthly_mentorship_agreements_v1 add column initial_abandon_proof jsonb;
      alter table monthly_mentorship_initial_closures_v1 add column kind text,add column resource_id text,add column status text;
      alter table purchases add column id uuid unique,add column monthly_mentorship_id uuid,add column kind text,
        add column access_granted boolean,add column first_access_at timestamptz,add column paid_at timestamptz,
        add column earnings_credited_at timestamptz,add column paid_count int,add column status text;
      create function public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)
        returns boolean language sql as $$select false$$;`);
    const proposal=readFileSync('supabase/proposals/089-monthly-mentorship-initial-abandonment.sql','utf8');
    for(const name of ['assert_monthly_initial_unpaid_v1','complete_monthly_initial_abandonment_v1']){
      const functionSql=proposal.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\$\\$;`))?.[0];
      if(!functionSql)throw Error('Missing original monthly retirement function '+name);
      await db.exec(functionSql);
    }
    await db.exec(readFileSync('supabase/migrations/20260925222900_monthly_manual_first_terminal_release.sql','utf8'));
  }
}
