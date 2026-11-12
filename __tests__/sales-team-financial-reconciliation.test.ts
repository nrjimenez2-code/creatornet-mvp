/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {readTeamFinancialSnapshot,observeTeamPaymentEvent} from "@/lib/salesTeams/financialReadback";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock,refunds:Record<string,unknown>[],disputes:Record<string,unknown>[],balances:Record<string,unknown>;
const json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
beforeAll(async()=>{
 db=await teamSharedDatabase(createLocalPostgres());
 await db.exec(readFileSync("supabase/migrations/20261023000533_sales_team_payment_events.sql","utf8"));
 await db.exec("alter table profiles add column role text");
 await db.exec(readFileSync("supabase/migrations/20261021230016_sales_team_financial_statements.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20261023002620_sales_team_financial_reconciliation.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20261023012742_sales_team_admin_refund_dispatch.sql","utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set financial_reconciliation_enabled=true,refund_review_enabled=true,fulfillment_enabled=true,event_reconciliation_enabled=true");
 f=await seedTeamCapture(db);await db.query("update profiles set role='admin' where id=$1",[id(29)]);const receipt=await f.record();receiptId=String(receipt.id);refunds=[];disputes=[];balances={};let seq=0;
 raw=jest.fn(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Only original GETs permitted");
  const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:refunds,has_more:false}:path==="/v1/disputes"?{object:"list",data:disputes,has_more:false}:path.startsWith("/v1/refunds/")?refunds.find(r=>r.id===path.split("/").at(-1)):balances[path.split("/").at(-1)!];
  if(!value)throw Error(`Unexpected original GET ${path}`);return json({...value,lastResponse:{requestId:`req_check${++seq}`}});
 });
 c={admin:teamSupabaseFixture(db),stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
const inspect=()=>inspectTeamReceiptFinancials(c,receiptId,id(29));
function balance(key:string,source:string,kind:string,amount:number,fee:number){return {id:key,object:"balance_transaction",source,type:kind.startsWith("dispute")?"adjustment":kind,reporting_category:kind,currency:"usd",exchange_rate:null,amount,fee,net:amount-fee,created:f.base.charge.created,available_on:f.base.charge.created+86400,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};}
test("installs atomically and reconciles original capture without new sales or provider writes",async()=>{
 expect(await inspect()).toMatchObject({receiptId,held:false,completed:true});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1")).rows).toEqual([{n:1}]);
});
test("won dispute restores principal while preserving its actual net fee separately",async()=>{
 const purchase=await f.rpc<{purchaseId:string}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receiptId]);
 const before=Number((await db.query<{total_earnings_cents:string}>("select total_earnings_cents from profiles where id=$1",[f.contract.terms.creatorId])).rows[0].total_earnings_cents);
 f.base.charge.disputed=true;disputes=[{id:"du_original",object:"dispute",livemode:false,charge:"ch_original",payment_intent:"pi_original",currency:"usd",amount:1000,status:"won",created:f.base.charge.created,balance_transactions:[{id:"txn_withdraw"},{id:"txn_restore"}]}];
 balances={txn_withdraw:balance("txn_withdraw","du_original","dispute",-1000,1500),txn_restore:balance("txn_restore","du_original","dispute_reversal",1000,-500)};
 expect(await inspect()).toMatchObject({held:false});
 expect((await db.query("select processing_cost_cents::int original,financial_adjustment_cost_cents::int auxiliary,confirmed_loss_subtotal_cents::int loss from sales_team_receipts_v1")).rows).toEqual([{original:127,auxiliary:1000,loss:0}]);
 const statement=await f.rpc<{entries:{creatorAccounting:{actualFinancialAdjustmentCostCents:number}}[]}>("read_sales_team_statement_v1",[f.contract.terms.creatorId,f.contract.terms.creatorId,null,20]);
 expect(statement.entries[0].creatorAccounting.actualFinancialAdjustmentCostCents).toBe(1000);
 expect((await db.query("select processing_fee_cents::int total_cost,actual_stripe_fee_cents::int original,team_financial_adjustment_cost_cents::int aux from payment_fee_ledger")).rows).toEqual([{total_cost:1127,original:127,aux:1000}]);
 expect(Number((await db.query<{total_earnings_cents:string}>("select total_earnings_cents from profiles where id=$1",[f.contract.terms.creatorId])).rows[0].total_earnings_cents)).toBe(before-1000);
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchase.purchaseId,f.buyer])).toMatchObject({allowed:true});
 await inspect();expect(Number((await db.query<{total_earnings_cents:string}>("select total_earnings_cents from profiles where id=$1",[f.contract.terms.creatorId])).rows[0].total_earnings_cents)).toBe(before-1000);
});
test("unknown read outcome leaves a hold and resumes the same actor's pending UUID",async()=>{
 const original=raw.getMockImplementation()!;raw.mockRejectedValueOnce(Error("provider read unavailable"));await expect(inspect()).rejects.toThrow();
 const pending=(await db.query<{id:string}>("select id from sales_team_financial_checks_v1")).rows[0].id;raw.mockImplementation(original);
 expect(await inspect()).toMatchObject({checkId:pending,held:false});expect((await db.query("select count(*)::int n from sales_team_financial_checks_v1")).rows).toEqual([{n:1}]);
 const aliases=(await db.query<{request_id:string}>("select request_id from sales_team_financial_check_requests_v1 where request_id<>check_id")).rows;
 expect(aliases).toHaveLength(1);raw.mockClear();expect(await inspectTeamReceiptFinancials(c,receiptId,id(29),aliases[0].request_id)).toMatchObject({checkId:pending,held:false});expect(raw).not.toHaveBeenCalled();
});
test("ordinary creator cannot begin a financial admin inspection",async()=>{await denied(()=>inspectTeamReceiptFinancials(c,receiptId,id(1)),/FINANCIAL_CHECK_AUTHORITY_REQUIRED/);expect(raw).not.toHaveBeenCalled();});
test("admin queue is context pinned, bounded and denied to ordinary creators",async()=>{
 const page=await f.rpc<{rows:{receiptId:string;held:boolean;refunds:unknown[]}[];nextCursor:string|null}>("read_sales_team_financial_admin_queue_v1",[id(29),c.context,null,1]);
 expect(page).toMatchObject({rows:[{receiptId,held:false,refunds:[]}],nextCursor:null});
 await denied(()=>f.rpc("read_sales_team_financial_admin_queue_v1",[id(1),c.context,null,20]),/FINANCIAL_ADMIN_REQUIRED/);
 await denied(()=>f.rpc("read_sales_team_financial_admin_queue_v1",[id(29),{...c.context,mode:"live"},null,20]),/FINANCIAL_ADMIN_REQUIRED/);
 await denied(()=>f.rpc("read_sales_team_financial_admin_queue_v1",[id(29),c.context,id(27),20]),/INVALID_FINANCIAL_QUEUE_CURSOR/);
 await denied(()=>f.rpc("read_sales_team_financial_admin_queue_v1",[id(29),c.context,null,51]),/INVALID_FINANCIAL_QUEUE_LIMIT/);
});
const currentRevision=async()=>Number((await db.query<{observation_revision:number}>("select observation_revision from sales_team_receipts_v1")).rows[0].observation_revision);
function refunded(amount=1000){
 f.base.charge.amount_refunded=amount;
 refunds=[{id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",currency:"usd",amount,status:"succeeded",created:f.base.charge.created,balance_transaction:"txn_refund",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null}];
 balances={txn_refund:balance("txn_refund","re_original","refund",-amount,40)};
}
test.each(["creator","platform"] as const)("audited %s refund allocates its actual fees and preserves original charge cost",async(responsibility)=>{
 refunded();expect(await inspect()).toMatchObject({held:true});
 const args={actorId:id(29),receiptId,requestId:id(28),expectedRevision:await currentRevision(),refundId:"re_original",responsibility,reasonCode:responsibility==="creator"?"creator_discretionary" as const:"platform_technical_error" as const};
 expect(await reviewTeamRefundResponsibility(c,args)).toEqual({reviewId:id(28),holdRetained:true});
 expect(await inspect()).toMatchObject({held:false});
 const r=(await db.query<{original:number;aux:number;credit:number;aux_credit:number}>("select processing_cost_cents::int original,financial_adjustment_cost_cents::int aux,platform_processing_credit_cents::int credit,financial_processing_credit_cents::int aux_credit from sales_team_receipts_v1")).rows[0];
 expect(r).toMatchObject({original:127,aux:40,aux_credit:responsibility==="platform"?40:0});expect(r.credit>0).toBe(responsibility==="platform");
 expect(await reviewTeamRefundResponsibility(c,args)).toEqual({reviewId:id(28),holdRetained:true});
});
test("another actor's pending check blocks entitlement until independently completed",async()=>{
 await db.query("update profiles set role='admin' where id=$1",[id(28)]);
 await f.rpc("begin_sales_team_financial_check_v1",[id(27),receiptId,id(28),null,null,c.context]);
 expect(await inspect()).toMatchObject({held:true});
 expect(await inspectTeamReceiptFinancials(c,receiptId,id(28),id(27))).toMatchObject({held:false});
});
test("recovery of an already completed inspection reports a later pending hold",async()=>{
 const completed=await inspectTeamReceiptFinancials(c,receiptId,id(29),id(27));expect(completed.held).toBe(false);
 await db.query("update profiles set role='admin' where id=$1",[id(28)]);await f.rpc("begin_sales_team_financial_check_v1",[id(26),receiptId,id(28),null,null,c.context]);
 raw.mockClear();expect(await inspectTeamReceiptFinancials(c,receiptId,id(29),id(27))).toMatchObject({completed:true,held:true});expect(raw).not.toHaveBeenCalled();
});
test("failed refund debit and failure credit cancel principal and retain net auxiliary cost",async()=>{
 refunded();f.base.charge.amount_refunded=0;refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_failure";
 balances.txn_failure=balance("txn_failure","re_original","refund_failure",1000,-10);
 expect(await inspect()).toMatchObject({held:false});
 expect((await db.query("select financial_adjustment_cost_cents::int aux,confirmed_loss_subtotal_cents::int loss from sales_team_receipts_v1")).rows).toEqual([{aux:30,loss:0}]);
});
test.each(["fraction","missing","private","credit","sourceEvent","duplicateOwner"])("SQL rejects %s proof before accounting",async(kind)=>{
 refunded();await inspect();
 const begun=await f.rpc<{checkId:string;source:Parameters<typeof readTeamFinancialSnapshot>[1]}>("begin_sales_team_financial_check_v1",[id(27),receiptId,id(29),null,null,c.context]);
 const value=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true}),snapshot=json(value.snapshot) as unknown as {balanceEvidence:{entries:Record<string,unknown>[];financialProcessingCreditCents:number;owners:{refunds:unknown[]}};proof:Record<string,unknown>;capture:{receipt:Record<string,unknown>}};
 if(kind==="fraction")snapshot.balanceEvidence.entries[0].feeCents=1.5;
 if(kind==="missing")delete snapshot.proof.reviewHold;
 if(kind==="private")snapshot.capture.receipt.rawCustomer="private";
 if(kind==="credit")snapshot.balanceEvidence.financialProcessingCreditCents=1;
 if(kind==="sourceEvent")snapshot.proof.sourceEventId="evt_fabricated";
 if(kind==="duplicateOwner")snapshot.balanceEvidence.owners.refunds.push(snapshot.balanceEvidence.owners.refunds[0]);
 await denied(()=>f.rpc("complete_sales_team_financial_check_v1",[begun.checkId,value.revision,snapshot]),/FINANCIAL|ORIGINAL/);
});
test("balance economics changing between GETs retain the pending check and existing receipt",async()=>{
 refunded();const original=raw.getMockImplementation()!;let reads=0;
 raw.mockImplementation(async(method:string,path:string)=>{const result=await original(method,path);if(path==="/v1/balance_transactions/txn_refund"&&++reads===2){result.fee=41;result.net=-1041;result.fee_details[0].amount=41;}return result;});
 await expect(inspect()).rejects.toThrow(/reconciliation/);
 expect((await db.query("select review_hold,financial_adjustment_cost_cents::int aux from sales_team_receipts_v1")).rows).toEqual([{review_hold:true,aux:0}]);
 expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1")).rows).toEqual([{n:0}]);
});
test("more than 32 references retains review and admits no more than four simultaneous balance GETs",async()=>{
 refunded(33);const template=refunds[0];refunds=Array.from({length:33},(_,n)=>({...template,id:`re_R${n}`,amount:1,balance_transaction:`txn_R${n}`}));
 balances=Object.fromEntries(refunds.map(r=>[String(r.balance_transaction),balance(String(r.balance_transaction),String(r.id),"refund",-1,0)]));
 const original=raw.getMockImplementation()!;let active=0,maximum=0;
 raw.mockImplementation(async(method:string,path:string)=>{if(!balances[path.split("/").at(-1)!])return original(method,path);active++;maximum=Math.max(maximum,active);try{await new Promise(resolve=>setTimeout(resolve,2));return await original(method,path);}finally{active--;}});
 expect(await inspect()).toMatchObject({held:true});expect(maximum).toBe(4);expect(active).toBe(0);
 const reads=raw.mock.calls.filter(([,path])=>balances[path.split("/").at(-1)!]);expect(new Set(reads.map(([,path])=>path)).size).toBe(32);expect(reads).toHaveLength(64);
});
test("mixed-case same-second refunds use the same cumulative allocation order in SQL and runtime",async()=>{
 refunded(199);const template=refunds[0];refunds=[{...template,id:"re_a",amount:100,balance_transaction:"txn_a"},{...template,id:"re_A",amount:99,balance_transaction:"txn_A"}];
 balances={txn_a:balance("txn_a","re_a","refund",-100,2),txn_A:balance("txn_A","re_A","refund",-99,3)};
 await inspect();
 for(const [n,r] of refunds.entries())await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(25+n),expectedRevision:await currentRevision(),refundId:String(r.id),responsibility:n===0?"platform":"creator",reasonCode:n===0?"platform_technical_error":"creator_discretionary"});
 expect(await inspect()).toMatchObject({held:false});
});
test("an expired admission budget retains a durable pending check without further reads",async()=>{
 const original=raw.getMockImplementation()!,started=Date.now();let now=started;const clock=jest.spyOn(Date,"now").mockImplementation(()=>now);
 try{raw.mockImplementation(async(method:string,path:string)=>{const result=await original(method,path);now=started+45000;return result;});await expect(inspect()).rejects.toThrow();expect(raw).toHaveBeenCalledTimes(1);
  expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
 }finally{clock.mockRestore();}
});
test("real saved event and financial check complete atomically with a stable internal UUID",async()=>{
 const eventId="evt_originalFinancial";
 await f.rpc("begin_sales_team_payment_event_v1",[eventId,"payment_intent.succeeded",f.base.charge.created,"pi_original","pi_original","ch_original",c.context]);
 const source={saleId:f.sale,buyerId:f.buyer,obligationId:f.contract.obligationId,paymentIntentId:"pi_original",context:c.context};
 expect(await observeTeamPaymentEvent(c,source,eventId,true)).toMatchObject({held:false,receiptId});
 const before=(await db.query("select count(*)::int n from sales_team_financial_ledger_v1")).rows;
 expect(await observeTeamPaymentEvent(c,source,eventId,true)).toMatchObject({held:false});
 expect((await db.query("select count(*)::int n from sales_team_financial_checks_v1")).rows).toEqual([{n:1}]);
 expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:1}]);
 expect((await db.query("select count(*)::int n from sales_team_financial_ledger_v1")).rows).toEqual(before);
});
test("a financial completion failure rolls back the conservative event result and accounting",async()=>{
 const eventId="evt_atomicOriginal";
 await f.rpc("begin_sales_team_payment_event_v1",[eventId,"payment_intent.succeeded",f.base.charge.created,"pi_original","pi_original","ch_original",c.context]);
 const source={saleId:f.sale,buyerId:f.buyer,obligationId:f.contract.obligationId,paymentIntentId:"pi_original",context:c.context};
 const value=await readTeamFinancialSnapshot(c,source,{eventId,balances:true});value.snapshot.balanceEvidence!.financialProcessingCreditCents=10;
 await denied(()=>f.rpc("complete_sales_team_payment_event_v1",[eventId,value.revision,value.snapshot]),/FINANCIAL_CREDIT/);
 expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_financial_checks_v1")).rows).toEqual([{n:0}]);
});
test("financial history and RPCs deny authenticated client access",async()=>{
 await inspect();await db.exec("set local role authenticated");
 await denied(()=>db.query("select * from sales_team_financial_checks_v1"),/permission denied/);
 await denied(()=>f.rpc("begin_sales_team_financial_check_v1",[id(27),receiptId,id(29),null,null,c.context]),/permission denied/);
 await denied(()=>f.rpc("read_sales_team_financial_admin_queue_v1",[id(29),c.context,null,20]),/permission denied/);
});
test("a final guarded-patch failure rolls back every new financial schema and function change",async()=>{
 const isolated=await teamSharedDatabase(createLocalPostgres());
 try{
  await isolated.exec(readFileSync("supabase/migrations/20261023000533_sales_team_payment_events.sql","utf8"));
  await isolated.exec(readFileSync("supabase/migrations/20261021230016_sales_team_financial_statements.sql","utf8"));
  await isolated.exec("alter table profiles add column role text");
  const candidate=readFileSync("supabase/migrations/20261023002620_sales_team_financial_reconciliation.sql","utf8");
  const fault=candidate.replace("needle text:=$o$'actualProcessingCostCents',b.actual_processing_cost_cents,$o$","needle text:=$o$intentionally_unknown_final_definition$o$");
  expect(fault).not.toBe(candidate);await expect(isolated.exec(fault)).rejects.toThrow(/TEAM_FINANCIAL_STATEMENT_DEPENDENCY_DIFFERS/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('public.sales_team_financial_checks_v1') as checks,to_regprocedure('public.complete_sales_team_event_before_financial_v1(text,integer,jsonb)')::text as wrapper")).rows).toEqual([{checks:null,wrapper:null}]);
  expect((await isolated.query("select count(*)::int n from information_schema.columns where table_name='sales_team_receipts_v1' and column_name='financial_adjustment_cost_cents'")).rows).toEqual([{n:0}]);
 }finally{await isolated.close();}
},30000);
