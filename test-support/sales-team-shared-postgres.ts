import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {teamCaptureDatabase} from "./sales-team-capture-postgres";
const source=(name:string)=>readFileSync(name,"utf8");
const functionSource=(sql:string,name:string)=>{const starts=[`create function public.${name}(`,`create or replace function public.${name}(`];const start=starts.map(s=>sql.indexOf(s)).find(n=>n>=0);if(start===undefined)throw Error(name);const end=sql.indexOf("$$;",start);if(end<0)throw Error(name);return sql.slice(start,end+3);};
/** Structural fixture plus the real shared ledger constraints, delivery tables,
 * immutable/binding functions and legacy earnings functions. It deliberately
 * does not claim a full historical composer/CTA migration or hosted schema test. */
export async function teamSharedDatabase(db:PGlite){
 await teamCaptureDatabase(db);
 await db.exec(`alter table products add column deliver_url text,add column discord_invite_url text,add column whop_listing_url text,add column external_url text;
  update products set deliver_url='https://fixture.invalid/original-course';
  alter table posts add column title text,add column premium_path text,add column purchase_count integer not null default 0;
  alter table purchases add column buyer_user_id uuid,add column creator_id uuid,add column post_id uuid,add column order_id uuid,add column booking_id uuid,
   add column amount_cents bigint,add column currency text,add column status text,add column kind text,add column product_type text,add column title text,
   add column access_granted boolean default false,add column payment_intent_id text,add column session_id text,add column subscription_id text,
   add column paid_at timestamptz,add column earnings_credited_at timestamptz,add column earnings_credited_cents bigint,add column paid_count integer default 0;
  alter table orders add column creator_id uuid,add column amount_cents bigint,add column gross_amount bigint,add column platform_fee bigint,add column processing_fee bigint,
   add column total_creator_deduction bigint,add column creator_amount bigint,add column fee_schedule_version text,add column status text,add column currency text,
   add column stripe_payment_intent_id text,add column stripe_payment_id text,add column stripe_checkout_session_id text,add column stripe_charge_id text,
   add column stripe_balance_transaction_id text,add column actual_stripe_fee bigint,add column processing_fee_variance bigint,add column updated_at timestamptz default now();
  grant select,insert,update on profiles,posts,products,purchases,orders,booking_payments to service_role;`);
 const feeSql=source("supabase/schema/019-creator-processing-fees.sql");
 await db.exec(feeSql.slice(feeSql.indexOf("create table if not exists public.payment_fee_ledger ("),feeSql.indexOf("-- A primary-key insert by itself")));
 await db.exec(source("test-support/staging-one-time-earnings.sql"));
 for(const name of ["credit_payment_fee_ledger_earnings","apply_purchase_refund_earnings","apply_payment_fee_ledger_refund"])await db.exec(functionSource(feeSql,name));
 const delivery=source("supabase/migrations/20260930175120_composer_premium_delivery.sql");
 await db.exec(delivery.slice(delivery.indexOf("create table public.private_video_assets ("),delivery.indexOf("create table public.private_video_progress (")));
 for(const name of ["immutable_product_delivery_v1","prepare_checkout_delivery_v1","bind_purchase_delivery_v1"])await db.exec(functionSource(delivery,name));
 await db.exec(`create trigger team_fixture_revision_immutable before update or delete on product_delivery_revisions for each row execute function immutable_product_delivery_v1();
  create trigger team_fixture_video_immutable before update or delete on product_delivery_videos for each row execute function immutable_product_delivery_v1();
  create trigger team_fixture_snapshot_immutable before update or delete on checkout_delivery_snapshots for each row execute function immutable_product_delivery_v1();
  create trigger team_fixture_binding_immutable before update or delete on purchase_deliveries for each row execute function immutable_product_delivery_v1();
  create trigger purchase_delivery_bind after insert or update on purchases for each row execute function bind_purchase_delivery_v1();
  grant select,insert,update on private_video_assets,product_delivery_revisions,product_delivery_videos,checkout_delivery_snapshots,purchase_deliveries to service_role;`);
 await db.exec(source("supabase/migrations/20261022234208_sales_team_shared_fulfillment.sql"));
 return db;
}
