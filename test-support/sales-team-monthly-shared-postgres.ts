import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {bankAlertDatabase} from "./sales-team-bank-alerts-postgres";
import {seedTeamCapture} from "./sales-team-capture-postgres";

// Exact body from the bounded, approved Sales Team 18 installed-catalog receipt.
// Synthetic schema only: this is not a copy of installed application history.
export const installedMonthlyGuardSha256="6959384c7561421c0af7b2314a74518784440f1621cf19bf5282eddad4293770";
export const monthlySharedCandidate="supabase/migrations/20261104213012_sales_team_monthly_shared_compatibility.sql";
export async function monthlySharedDatabase(db:PGlite,install=true){
 await bankAlertDatabase(db);
 await db.exec(`alter table purchases add column monthly_mentorship_id uuid,add column target_months integer;
  alter table monthly_mentorship_agreements_v1 add column purchase_id uuid,add column creator_id uuid,add column post_id uuid,add column stripe_subscription_id text;`);
 const guard=readFileSync("test-support/fixtures/sales-team-installed-monthly-guard.sql","utf8");
 if(createHash("sha256").update(guard).digest("hex")!==installedMonthlyGuardSha256)throw Error("Installed guard fixture drift");
 await db.exec(guard+`;revoke all on function public.guard_monthly_mentorship_purchase_v1() from public,anon,authenticated,service_role;
  create trigger guard_monthly_mentorship_purchase_v1 before insert or update on public.purchases
  for each row execute function public.guard_monthly_mentorship_purchase_v1();`);
 if(install)await db.exec(readFileSync(monthlySharedCandidate,"utf8"));
}
export const monthlySharedReady=async(db:PGlite)=>(await db.query<{ready:boolean}>("select creatornet_team_private.team_monthly_shared_ready_v1() ready")).rows[0].ready;
export const enableMonthlySharedFixture=(db:PGlite)=>db.exec("update sales_team_monthly_shared_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.team_monthly_shared_contract_digest_v1()");
export const seedMonthlySharedCapture=(db:PGlite)=>seedTeamCapture(db,{paymentKind:"monthly",beforeApproval:async()=>{
 await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",minimumMonths:1,autoRenew:true}]);
}});
