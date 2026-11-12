import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {savedMethodDatabase} from "./sales-team-saved-method-postgres";
import {seedTeamCapture,captureRpc} from "./sales-team-capture-postgres";
import {teamSupabaseFixture} from "./sales-team-supabase-fixture";
import {teamFixtureId as id} from "./sales-team-postgres";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

export const surplusReservationCandidate="supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql";
export async function surplusDatabase(db:PGlite){
 await savedMethodDatabase(db);
 for(const file of ["supabase/migrations/20261027024721_sales_team_automatic_collection.sql",surplusReservationCandidate])await db.exec(readFileSync(file,"utf8"));
 return db;
}
/** Existing confirmation/capture owners, with an optional deliberately missing
 * receipt to model lost acknowledgement. All account/bank/cash data is fake. */
export async function seedTeamSurplusCash(db:PGlite,options:{recordReceipt?:boolean;availableCents?:number;maximumCents?:number;confirmationUncertain?:boolean}={}){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true");
 const f=await seedTeamCapture(db,{confirmationUncertain:options.confirmationUncertain});if(options.recordReceipt!==false)await f.record();
 await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=true,surplus_reservations_enabled=true");
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic surplus fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 await db.query("update sales_team_surplus_policy_v1 set context=$1,destination_id='ba_fixture',minimum_cents=50,maximum_cents=$2,cost_reserve_cents=20,prerequisites_verified=true,evidence='{\"scope\":\"synthetic only; no bank approval\"}',contract_sha256=creatornet_team_private.surplus_contract_digest_v1()",[f.contract.context,options.maximumCents??1000000]);
 let sequence=0,available=options.availableCents??1000000;
 const raw=async(method:string,path:string)=>{if(method!=="GET"||path!=="/v1/balance")throw Error("Surplus cash fixture permits balance GET only");return {object:"balance",livemode:false,available:[{currency:"usd",amount:available,source_types:{card:available}}],pending:[],lastResponse:{requestId:`req_surplusCash${++sequence}`}};};
 const c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);
 const claim=(runId=id(200),admitNew=true)=>rpc<{status:string;runId:string;leaseToken:string}>("claim_sales_team_surplus_run_v1",[runId,c.context,admitNew]);
 return {f,c,rpc,claim,setAvailable:(cents:number)=>{available=cents;}};
}
