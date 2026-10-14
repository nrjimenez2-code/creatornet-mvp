import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
export async function installServerPaymentJournal(db:PGlite){
  // Minimal structural dependencies; the two production migrations, including
  // their role permissions and functions, are executed unchanged below.
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_purchase_consents_v1(id uuid primary key,terms jsonb,accepted_at timestamptz default clock_timestamp());
    create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,purchase_consent_id uuid,checkout_kind text,status text,
      buyer_installment_reservation_id uuid,original_request_protocol text,original_request jsonb,
      stripe_checkout_session_id text,stripe_checkout_url text,updated_at timestamptz default now());
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid,attempt_id uuid,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,status text,released_at timestamptz,
      accepted_at timestamptz,terms jsonb,fingerprint text,destination_id text);
    create table buyer_mentorship_bootstraps_v1(reservation_id uuid,customer_id text,anchor_seconds bigint);
    create table buyer_mentorship_bootstrap_operations_v1(reservation_id uuid,step text,request jsonb,result_id text,bound_at timestamptz,lease_until timestamptz);
    create table buyer_mentorship_first_receipts_v1(reservation_id uuid);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid);
    create table buyer_mentorship_abandonment_holds_v1(reservation_id uuid);
    create table purchases(buyer_id uuid,product_id uuid,post_id uuid);
    create table profiles(id uuid,stripe_account_id text,stripe_onboarding_complete boolean);
    create table orders(id uuid,buyer_id uuid,creator_id uuid,post_id uuid,status text,currency text,amount_cents bigint,
      gross_amount bigint,platform_fee bigint,processing_fee bigint,total_creator_deduction bigint,creator_amount bigint,fee_schedule_version text);`);
  for(const name of ["20260921173504_server_payment_protocol.sql","20260921175109_server_payment_intent_operations.sql",
    "20260921181924_server_payment_confirmation_operations.sql","20260921190318_server_payment_card_replacement.sql",
    "20260921200823_server_payment_authentication_capability.sql","20260921201913_server_payment_intent_cancellation.sql"])
    await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  await db.exec(readFileSync("supabase/migrations/20260924071323_manual_intent_card_only.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260924074115_manual_card_method.sql","utf8"));
}
