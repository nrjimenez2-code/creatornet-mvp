import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {teamSharedDatabase} from "./sales-team-shared-postgres";
import {teamCashCandidate} from "./sales-team-cash-postgres";
export const sharedCashCandidate="supabase/migrations/20261023030002_sales_team_shared_cash_coverage.sql";
export const sharedCashReconciliationCandidate="supabase/migrations/20261023034510_sales_team_shared_cash_reconciliation.sql";
const source=(path:string)=>readFileSync(path,"utf8");
const fn=(sql:string,marker:string)=>{const start=sql.indexOf(marker),end=sql.indexOf("$$;",start);if(start<0||end<0)throw Error(marker);return sql.slice(start,end+3);};
/** Actual team candidates, 021 refund engine and current 061 tip-recovery
 * function on structural parent tables. Not a historical hosted-schema install. */
export async function sharedCashDatabase(db:PGlite,install=true){
 await teamSharedDatabase(db);
 await db.exec("alter table profiles add column role text;create table public.admin_actions(id bigint generated always as identity primary key,actor_id uuid,action text,target_table text,target_id uuid,reason text)");
 for(const name of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql","20261023012742_sales_team_admin_refund_dispatch.sql"])await db.exec(source(`supabase/migrations/${name}`));
 await db.exec(source(teamCashCandidate));
 await db.exec(source("supabase/schema/021-admin-refund-operations.sql"));
 const tips=source("supabase/schema/060-video-tipping.sql"),start=tips.indexOf("create table if not exists public.tip_dispute_recoveries ("),end=tips.indexOf("create index if not exists tip_dispute_recoveries_tip_idx",start);
 if(start<0||end<0)throw Error("Current tip recovery table missing");
 await db.exec("create table public.tips(id uuid primary key,creator_id uuid,stripe_destination_account_id text,currency text,dispute_status text,updated_at timestamptz default now());grant select,insert,update on public.tips to service_role");
 await db.exec(tips.slice(start,end));
 await db.exec(fn(source("supabase/schema/061-video-tipping-checkout-idempotency.sql"),"create function public.record_tip_dispute_recovery("));
 await db.exec("grant select,insert,update on public.tip_dispute_recoveries to service_role");
 if(install)await db.exec(source(sharedCashCandidate));
 return db;
}
