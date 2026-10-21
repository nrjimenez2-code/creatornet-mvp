/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;let scope:TeamOperationScope;let context:object;
const request={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v1/payment_intents",params:{amount:10001,currency:"usd",confirm:false}};
const rpc=async(name:string,values:unknown[])=>{const result=await db.query<{result:Record<string,unknown>}>(`select public.${name}(${values.map((_,n)=>`$${n+1}`).join(",")}) result`,values);return result.rows[0].result;};
const claim=(params=request,s=scope)=>rpc("claim_sales_team_provider_operation_v1",[teamOperationId(s),JSON.stringify(s),JSON.stringify(context),JSON.stringify(params)]);
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{db=await salesTeamSaleDatabase(createLocalPostgres());await db.exec(readFileSync("supabase/migrations/20261021215909_sales_team_provider_journal_and_ledger.sql","utf8"));},30000);
beforeEach(async()=>{
 await db.exec("begin");await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db);const draft=await draftTeamSale(db,offer.options[0].id);
 await rpc("accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]);context=draft.source.financialConfig.context;
 scope={scopeId:draft.saleId,scopeKey:"intent:1",kind:"intent",saleId:draft.saleId,creatorId:id(1),actorId:id(10),workerRunId:null};
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});

test("one SQL claim admits dispatch; duplicate claims return busy without another lease",async()=>{
 const first=await claim(),second=await claim();expect(first.status).toBe("dispatch");expect(second.status).toBe("busy");expect(second.operation).toEqual(first.operation);
 await denied(()=>claim({...request,params:{amount:10002,currency:"usd",confirm:false}}),/ORIGINAL_PROVIDER_REQUEST_CHANGED/);
});
test("unknown and expired claims require reconciliation instead of another dispatch",async()=>{
 const first=await claim();const op=first.operation as {lease_token:string};await rpc("mark_sales_team_provider_unknown_v1",[teamOperationId(scope),op.lease_token]);
 expect((await claim()).status).toBe("reconciliation_required");expect((await db.query("select * from public.sales_team_financial_alerts_v1")).rows).toHaveLength(1);
 await rpc("bind_sales_team_provider_operation_v1",[teamOperationId(scope),"pi_original","req_read",true]);expect((await claim()).status).toBe("bound");
 expect((await db.query<{status:string}>("select status from public.sales_team_financial_alerts_v1")).rows[0].status).toBe("resolved");
});

test("a missing reconciliation flag cannot bypass an expired dispatch lease",async()=>{
 await claim();await db.exec("update public.sales_team_provider_operations_v1 set lease_until=now()-interval '1 second'");
 for(const flag of [false,null])await denied(()=>rpc("bind_sales_team_provider_operation_v1",[teamOperationId(scope),"pi_original","req_read",flag]),/PROVIDER_BINDING_REQUIRES_RECONCILIATION/);
 await rpc("bind_sales_team_provider_operation_v1",[teamOperationId(scope),"pi_original","req_read",true]);expect((await claim()).status).toBe("bound");
});
test("new activity closes on rollback while bound original readback remains available",async()=>{
 const first=await claim(),op=first.operation as {lease_token:string};await rpc("bind_sales_team_provider_operation_v1",[teamOperationId(scope),"pi_original","req_created",false]);
 await db.exec("update public.sales_team_controls_v1 set new_sales_enabled=false,access_enabled=false");expect((await claim()).status).toBe("bound");
 expect((await claim(request,{...scope,scopeKey:"intent:2"})).status).toBe("not_enabled");
 await denied(()=>rpc("assert_sales_team_provider_dispatch_v1",[teamOperationId(scope),op.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);
});
test("a different buyer, platform context or unauthenticated SQL caller cannot claim",async()=>{
 expect((await claim(request,{...scope,actorId:id(11)})).status).toBe("not_enabled");
 context={...context,platformAccountId:"acct_foreign"};expect((await claim()).status).toBe("not_enabled");
 await db.exec("set local role authenticated");await denied(()=>claim(),/permission denied/);
});
test("bank-transfer and withdrawal admission requires a live settlement worker and its separate control",async()=>{
 expect((await claim(request,{...scope,kind:"transfer",scopeKey:"transfer:1",actorId:null})).status).toBe("not_enabled");
 await db.exec("update public.sales_team_controls_v1 set settlement_enabled=true");
 expect((await claim(request,{...scope,kind:"withdrawal",scopeKey:"withdrawal:1",actorId:null})).status).toBe("not_enabled");
});
