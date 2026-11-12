import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {bankAlertDatabase} from "./sales-team-bank-alerts-postgres";
import {seedTeamCapture} from "./sales-team-capture-postgres";

// Exact body from the bounded, approved Sales Team 18 installed-catalog receipt.
// Synthetic schema only: this is not a copy of installed application history.
export const installedMonthlyGuardSha256="6959384c7561421c0af7b2314a74518784440f1621cf19bf5282eddad4293770";
export const monthlySharedCandidate="supabase/migrations/20261104213012_sales_team_monthly_shared_compatibility.sql";
export const discoverLossCandidate="supabase/migrations/20261106012534_sales_team_discover_confirmed_losses.sql";
/** Mirror committed Discover source privileges, separately from pinned body
 * evidence, which did not inspect the complete current hosted ACL/security. */
export const mirrorDiscoverSecurityFixture=(db:PGlite)=>db.exec("revoke all on function public.reconcile_discover_sale_v1(uuid),public.discover_ledger_changed_v1() from public,anon,authenticated;grant execute on function public.reconcile_discover_sale_v1(uuid) to service_role;");
export async function installDiscoverLossFixture(db:PGlite){await mirrorDiscoverSecurityFixture(db);await db.exec(readFileSync(discoverLossCandidate,"utf8"));}
export async function monthlySharedDatabase(db:PGlite,install=true){
 await bankAlertDatabase(db);
 await installMonthlySharedGuardFixture(db);
 if(install)await db.exec(readFileSync(monthlySharedCandidate,"utf8"));
}
export async function installMonthlySharedGuardFixture(db:PGlite){
 await db.exec(`alter table purchases add column monthly_mentorship_id uuid,add column target_months integer;
  alter table monthly_mentorship_agreements_v1 add column purchase_id uuid,add column creator_id uuid,add column post_id uuid,add column stripe_subscription_id text;`);
 const guard=readFileSync("test-support/fixtures/sales-team-installed-monthly-guard.sql","utf8");
 if(createHash("sha256").update(guard).digest("hex")!==installedMonthlyGuardSha256)throw Error("Installed guard fixture drift");
 await db.exec(guard+`;revoke all on function public.guard_monthly_mentorship_purchase_v1() from public,anon,authenticated,service_role;
  create trigger guard_monthly_mentorship_purchase_v1 before insert or update on public.purchases
  for each row execute function public.guard_monthly_mentorship_purchase_v1();`);
}
export const monthlySharedReady=async(db:PGlite)=>(await db.query<{ready:boolean}>("select creatornet_team_private.team_monthly_shared_ready_v1() ready")).rows[0].ready;
export const enableMonthlySharedFixture=(db:PGlite)=>db.exec("update sales_team_monthly_shared_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.team_monthly_shared_contract_digest_v1()");
export const seedMonthlySharedCapture=(db:PGlite)=>seedTeamCapture(db,{paymentKind:"monthly",beforeApproval:async()=>{
 await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",minimumMonths:1,autoRenew:true}]);
}});

/** Portable version of Sales19's combined probe. Only the saved routine bodies
 * and trigger definitions were inspected on the hosted database. Dependencies
 * below remain structural; this is not installed/history or RLS acceptance. */
export async function monthlySharedAccountingDatabase(db:PGlite,install=true){
 await monthlySharedDatabase(db,false);
 await installMonthlySharedAccountingFixture(db);
 // Finish the inspected predecessors first so callers can seed history before
 // F53. This does not defer or re-test the earlier structural/team stack.
 if(install)await db.exec(readFileSync(monthlySharedCandidate,"utf8"));
}
/** The same pinned legacy owners before F11 or behind its retained wrappers.
 * Schema dependencies are structural, not a complete installed migration chain. */
export async function installMonthlySharedAccountingFixture(db:PGlite,teamWrapped=true){
 const pinned=JSON.parse(readFileSync("test-support/fixtures/sales-team-installed-shared-accounting.json","utf8")) as {
  routines:{signature:string;definition:string;sha256:string}[];
  triggers:{tgname:string;enabled:string;definition:string}[];
  legacyDelegates:{signature:string;definition:string;definitionSha256:string}[];
  discovery:{signature:string;definition:string;sha256:string}[];
 };
 const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
 if(hash(JSON.stringify(pinned))!=="65a06992bdd470a9136a7c38f8c755785edd136535d19da0469e15fe0faae50c")throw Error("Installed accounting fixture drift");
 await db.exec(`alter table purchases add column fixed_service_consent_id uuid;
  alter table products add column post_id uuid;
  alter table product_checkout_attempts add column purchase_consent_id uuid,add column stripe_checkout_session_id text,add column creator_id uuid,add column post_id uuid;
  alter table monthly_mentorship_agreements_v1 add column initial_abandoned_at timestamptz,add column covered_months integer default 0,add column initial_abandon_proof jsonb;
  create table product_purchase_consents_v1(id uuid primary key,terms jsonb);
  create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key,financial_access boolean,access_updated_at timestamptz);`);
 // Ordinary historical refunds need the retained purchase fee columns too;
 // the earlier shared fixture extracted only 019's ledger table/functions.
 const fees=readFileSync("supabase/schema/019-creator-processing-fees.sql","utf8"),purchaseFees=fees.indexOf("alter table public.purchases"),purchaseFeesEnd=fees.indexOf("-- Buyers still need",purchaseFees);
 if(purchaseFees<0||purchaseFeesEnd<purchaseFees)throw Error("Legacy purchase fee dependency missing");
 await db.exec(fees.slice(purchaseFees,purchaseFeesEnd));
 for(const r of pinned.routines){
  if(hash(r.definition)!==r.sha256)throw Error("Pinned routine drift: "+r.signature);
  if(r.signature==="public.guard_monthly_mentorship_purchase_v1()")continue;
  await db.exec(r.definition);
  await db.exec(r.signature==="public.purchases_fill_ids()"?`grant execute on function ${r.signature} to public,anon,authenticated,service_role;`:
   `revoke all on function ${r.signature} from public,anon,authenticated,service_role;`+(r.signature==="public.bind_purchase_delivery_v1()"?`grant execute on function ${r.signature} to service_role;`:""));
 }
 for(const t of pinned.triggers){
  if(t.enabled!=="O")throw Error("Expected enabled pinned trigger");
  if(!["guard_monthly_mentorship_purchase_v1","purchase_delivery_bind"].includes(t.tgname))await db.exec(t.definition);
 }
 for(const r of pinned.legacyDelegates){
  if(hash(r.definition)!==r.definitionSha256)throw Error("Pinned delegate drift");
  const name=r.signature.slice(7,r.signature.indexOf("("));
  // Before F11 these are the original public owners. Afterwards never replace
  // the public F11 guards; restore the inspected bodies behind those guards.
  await db.exec(teamWrapped?r.definition.replace("public."+name+"(","public."+name+"_before_team_v1("):r.definition);
 }
 await db.exec(`alter table orders alter column amount_cents type integer;
  alter table posts add column interests text[] default '{}',add column topics text[] default '{}';
  create table discover_booking_attribution_v1(id uuid primary key,user_id uuid,creator_id uuid,post_id uuid,verified_at timestamptz,canceled_at timestamptz,created_at timestamptz default now());
  create table discover_events_v1(id uuid primary key default gen_random_uuid(),actor text,user_id uuid,post_id uuid,creator_id uuid,kind text,entity_key text,categories text[],topics text[],audience text,offer_type text,amount_cents bigint,currency text,occurred_at timestamptz,valid boolean);
  create unique index discover_sale_entity_v1 on discover_events_v1(entity_key) where kind in ('purchase','mentorship_purchase');
  grant select,insert,update,delete on discover_booking_attribution_v1,discover_events_v1 to service_role;`);
 const taxonomy=readFileSync("supabase/migrations/20260913004646_discover_taxonomy.sql","utf8");
 for(const name of ["canonical_interest_v1","canonical_interests_v1"]){
  const start=taxonomy.indexOf("create or replace function public."+name+"("),end=taxonomy.indexOf("$$;",start);
  if(start<0||end<start)throw Error("Taxonomy dependency missing");await db.exec(taxonomy.slice(start,end+3));
 }
 for(const r of pinned.discovery){if(hash(r.definition)!==r.sha256)throw Error("Pinned discovery drift");await db.exec(r.definition);}
 await db.exec("create trigger discover_ledger_changed_v1 after insert or update on payment_fee_ledger for each row execute function public.discover_ledger_changed_v1()");
}
