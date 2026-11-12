import {readTeamBeneficiaryPayout,type TeamBeneficiaryPayoutSource} from "@/lib/salesTeams/beneficiaryPayoutReadback";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {readTeamBoundTransfer} from "@/lib/salesTeams/transferReadback";
import type {TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
const stamp=Math.floor(Date.parse("2026-10-29T20:00:00Z")/1000),uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.spyOn(Date,"now").mockReturnValue(stamp*1000);});afterEach(()=>{jest.restoreAllMocks();});
type Value=Record<string,unknown>;
type Response=Value&{lastResponse:{requestId:string;headers:Record<string,string>;statusCode:number}};
type Options={apiVersion:string;stripeAccount?:string;maxNetworkRetries:number;timeout:number};
async function fixture(){
 const scope:TeamOperationScope={scopeId:uuid(81),scopeKey:"settlement:v1",kind:"transfer",saleId:uuid(20),creatorId:uuid(1),actorId:null,workerRunId:uuid(80)},operationId=teamOperationId(scope);
 const request={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST" as const,path:"/v1/transfers",params:{amount:2000,currency:"usd",destination:"acct_creator",source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${scope.saleId}`,
  metadata:{team_protocol:"creatornet-team-distribution-v1",team_sale_id:scope.saleId!,team_receipt_id:uuid(30),team_transfer_request_id:scope.scopeId,team_provider_operation_id:operationId,team_beneficiary:"creator"}}};
 const q:TeamTransferRequest={id:scope.scopeId,operation_id:operationId,receipt_id:uuid(30),sale_id:scope.saleId!,creator_id:scope.creatorId!,beneficiary:"creator",beneficiary_user_id:uuid(1),destination_id:"acct_creator",amount_cents:2000,receipt_revision:3,original_worker_run_id:uuid(80),chargeId:"ch_original",approvedRecipientId:"acct_creator",context,request,scope,canceled:false,completed:true,created_at:new Date((stamp-200)*1000).toISOString(),
  operation:{...scope,id:operationId,context,request,status:"bound",idempotency_key:`cn-team-v1:${operationId}`,first_dispatch_at:new Date((stamp-200)*1000).toISOString(),lease_until:null,provider_id:"tr_original",provider_request_id:"req_originalPost"}};
 const transfer={id:"tr_original",object:"transfer",amount:2000,amount_reversed:0,balance_transaction:"txn_transfer",created:stamp-180,currency:"usd",destination:"acct_creator",destination_payment:"py_destination",livemode:false,metadata:request.params.metadata,
  reversed:false,reversals:{object:"list",data:[],has_more:false,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${scope.saleId}`,description:"private transfer text"};
 const debit={id:"txn_transfer",object:"balance_transaction",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",amount:-2000,fee:0,net:-2000,exchange_rate:null,created:stamp-180,available_on:stamp-170,status:"available",fee_details:[],description:"private platform text"};
 const credit={...debit,id:"txn_credit",source:"py_destination",type:"payment",reporting_category:"transfer",amount:2000,net:2000};
 const other={...credit,id:"txn_other",source:"py_unrelated",amount:3500,net:3500,description:"private unrelated banking text"};
 const payout={id:"po_original",object:"payout",amount:5500,automatic:true,method:"standard",type:"bank_account",status:"paid",currency:"usd",destination:"ba_original",created:stamp-60,arrival_date:stamp,
  livemode:false,reconciliation_status:"completed",balance_transaction:"txn_payout",failure_balance_transaction:null as string|null,failure_code:null as string|null,original_payout:null,reversed_by:null,
  statement_descriptor:"private bank statement",trace_id:{status:"supported",value:"private bank trace"}};
 const payoutDebit={...debit,id:"txn_payout",source:"po_original",type:"payout",reporting_category:"payout",amount:-5500,net:-5500,created:stamp-60};
 const platform:Record<string,Value>={"/v1/transfers/tr_original":transfer,"/v1/balance_transactions/txn_transfer":debit};
 const connected:Record<string,Value>={"/v1/payouts/po_original":payout,"/v1/balance_transactions":{object:"list",url:"/v1/balance_transactions",data:[credit,other],has_more:false},
  "/v1/balance_transactions/txn_credit":credit,"/v1/balance_transactions/txn_payout":payoutDebit};
 let count=0;const raw=jest.fn(async(method:string,path:string,_params:Value,options:Options):Promise<Response>=>{
  if(method!=="GET")throw Error("No financial write permitted");const value=(options.stripeAccount?connected:platform)[path];if(!value)throw Error("Unexpected provider scope or path");
  return {...structuredClone(value),lastResponse:{requestId:`req_read${++count}`,headers:{},statusCode:200}};
 });
 const c={context,observeContext:jest.fn(async()=>context),stripe:{rawRequest:raw}};
 const proof=await readTeamBoundTransfer(c,q);raw.mockClear();c.observeContext.mockClear();
 const source:TeamBeneficiaryPayoutSource={request:q,completion:{request_id:q.id,transfer_id:"tr_original",balance_id:"txn_transfer",proof}};
 return {c,q,source,raw,platform,connected,transfer,debit,credit,other,payout,payoutDebit,run:()=>readTeamBeneficiaryPayout(c,source,"po_original")};
}
test("a completed original is independently linked to an exact automatic payout without claiming bank receipt",async()=>{
 const f=await fixture(),before=structuredClone(f.source),proof=await f.run();
 expect(proof).toMatchObject({version:"creatornet-beneficiary-payout-observation-v1",requestId:f.q.id,connectedAccountId:"acct_creator",transferId:"tr_original",destinationPaymentId:"py_destination",
  transferAmountCents:2000,payout:{id:"po_original",amountCents:5500,destinationId:"ba_original",status:"paid"},credit:{id:"txn_credit",netCents:2000},memberCount:2,bankConfirmed:false});
 expect(proof.membersSha256).toMatch(/^[a-f0-9]{64}$/);expect(proof.connectedReadRequestIds).toHaveLength(6);expect(f.source).toEqual(before);
 expect(f.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect(f.raw.mock.calls.slice(0,4).every(([, , ,o])=>!o.stripeAccount)).toBe(true);
 expect(f.raw.mock.calls.slice(4).every(([, , ,o])=>o.stripeAccount==="acct_creator"&&o.apiVersion===TEAM_STRIPE_API_VERSION&&o.maxNetworkRetries===0&&o.timeout>0&&o.timeout<=10000)).toBe(true);
 expect(f.raw.mock.calls.filter(([,path])=>path==="/v1/balance_transactions").map(([, ,params])=>params)).toEqual([{payout:"po_original",limit:100},{payout:"po_original",limit:100}]);
 expect(JSON.stringify(proof)).not.toMatch(/private|py_unrelated|txn_other|statement_descriptor|trace_id/);
});
test.each(["uncompleted","canceled","foreign_context","foreign_completion"])("%s originals are rejected before provider reads",async kind=>{
 const f=await fixture();if(kind==="uncompleted")f.q.completed=false;if(kind==="canceled")f.q.canceled=true;if(kind==="foreign_context")f.c.context={...context,platformAccountId:"acct_other"};if(kind==="foreign_completion")f.source.completion.request_id=uuid(92);
 await expect(f.run()).rejects.toThrow();expect(f.raw).not.toHaveBeenCalled();
});
test.each(["transfer_id","balance_id","destination_payment","request_id","operation_id","recipient","retained_balance"])("a changed retained %s cannot be linked to a payout",async kind=>{
 const f=await fixture(),p=f.source.completion.proof;
 if(kind==="transfer_id")f.source.completion.transfer_id="tr_other";if(kind==="balance_id")f.source.completion.balance_id="txn_other";if(kind==="destination_payment")p.transfer.destinationPaymentId="py_other";
 if(kind==="request_id")p.requestId=uuid(95);if(kind==="operation_id")p.operationId=uuid(96);if(kind==="recipient")p.transfer.destinationId="acct_other";if(kind==="retained_balance")p.balance.netCents=-1999;
 await expect(f.run()).rejects.toThrow(/requires review/);expect(f.raw.mock.calls.some(([, , ,o])=>o.stripeAccount)).toBe(false);
});
test("a later reversal cannot silently produce a new unreversed payout observation",async()=>{
 const f=await fixture();f.transfer.amount_reversed=1;await expect(f.run()).rejects.toThrow(/requires reconciliation/);expect(f.raw).toHaveBeenCalledTimes(1);
});
test.each(["automatic","method","type","mode","currency","destination","reconciliation","older","reversed","amount","id"])("unsupported or foreign payout %s remains unresolved",async kind=>{
 const f=await fixture();if(kind==="automatic")f.payout.automatic=false;if(kind==="method")f.payout.method="instant";if(kind==="type")f.payout.type="card";if(kind==="mode")f.payout.livemode=true;
 if(kind==="currency")f.payout.currency="eur";if(kind==="destination")f.payout.destination="card_other";if(kind==="reconciliation")f.payout.reconciliation_status="in_progress";
 if(kind==="older")f.payout.created=stamp-300;if(kind==="reversed")Object.assign(f.payout,{reversed_by:"po_reverse"});if(kind==="amount")f.payout.amount=0;if(kind==="id")f.payout.id="po_other";
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test.each(["pending","in_transit","paid","failed","canceled"])("provider %s is observed separately and never proves bank receipt",async status=>{
 const f=await fixture();f.payout.status=status;const proof=await f.run();expect(proof.payout.status).toBe(status);expect(proof.bankConfirmed).toBe(false);
});
test("a later failed payout retains its exact return observation without rewriting original money",async()=>{
 const f=await fixture();Object.assign(f.payout,{status:"failed",failure_balance_transaction:"txn_return",failure_code:"account_closed"});
 f.connected["/v1/balance_transactions/txn_return"]={...f.payoutDebit,id:"txn_return",type:"payout_failure",amount:5500,net:5500};
 const proof=await f.run();expect(proof).toMatchObject({payout:{status:"failed",returnBalanceId:"txn_return"},returned:{id:"txn_return",amountCents:5500},bankConfirmed:false});
});
test.each(["source","amount","status","currency","fee","duplicate","total","missing","debit_in_members"])("invalid payout member %s cannot establish inclusion",async kind=>{
 const f=await fixture();if(kind==="source")f.credit.source="py_other";if(kind==="amount"){f.credit.amount=2001;f.credit.net=2001;}if(kind==="status")f.credit.status="pending";
 if(kind==="currency")f.credit.currency="eur";if(kind==="fee")f.credit.fee=1;if(kind==="duplicate")f.connected["/v1/balance_transactions"].data=[f.credit,{...f.credit,id:"txn_duplicate"}];
 if(kind==="total")f.payout.amount=5501;if(kind==="missing")f.connected["/v1/balance_transactions"].data=[f.other];if(kind==="debit_in_members")f.connected["/v1/balance_transactions"].data=[f.credit,f.payoutDebit];
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test("independent credit read must agree with exact payout membership",async()=>{
 const f=await fixture();f.connected["/v1/balance_transactions/txn_credit"]={...f.credit,source:"py_foreign"};await expect(f.run()).rejects.toThrow(/requires review/);
});
test.each(["source","amount","type","id"])("the payout debit %s must belong to that payout",async kind=>{
 const f=await fixture();if(kind==="source")f.payoutDebit.source="po_other";if(kind==="amount"){f.payoutDebit.amount=-5501;f.payoutDebit.net=-5501;}if(kind==="type")f.payoutDebit.type="transfer";if(kind==="id")f.payoutDebit.id="txn_other";
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test.each(["members","payout","context"])("%s changing between independent reads cannot produce evidence",async kind=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let members=0,payouts=0;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(options.stripeAccount){
  if(path==="/v1/balance_transactions"&&++members===2&&kind==="members")v.data=[f.credit,{...f.other,id:"txn_changed"}];
  if(path==="/v1/payouts/po_original"&&++payouts===2&&kind==="payout")v.status="failed";
  if(kind==="context")f.c.observeContext.mockResolvedValue({...context,platformAccountId:"acct_other"});
 }return v;});await expect(f.run()).rejects.toThrow(/requires review/);
});
test("a complete two-page batch is repeated with exact server-owned pagination",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(path==="/v1/balance_transactions"){
  expect(params.payout).toBe("po_original");v.data=params.starting_after?[f.other]:[f.credit];v.has_more=!params.starting_after;
 }return v;});expect((await f.run()).memberCount).toBe(2);
 expect(f.raw.mock.calls.filter(([,p])=>p==="/v1/balance_transactions").map(([, ,p])=>p.starting_after)).toEqual([undefined,"txn_credit",undefined,"txn_credit"]);
});
test("an incomplete batch stops after three pages, never treating truncation as complete",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let pages=0;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(path==="/v1/balance_transactions"){v.data=[{...f.other,id:`txn_page${++pages}`}];v.has_more=true;}return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(pages).toBe(3);
});
test.each(["empty_more","duplicate_id","bad_url","missing_more","over_limit"])("malformed pagination %s is rejected",async kind=>{
 const f=await fixture(),list=f.connected["/v1/balance_transactions"];if(kind==="empty_more"){list.data=[];list.has_more=true;}if(kind==="duplicate_id")list.data=[f.credit,f.credit];
 if(kind==="bad_url")list.url="/v1/payouts";if(kind==="missing_more")delete list.has_more;if(kind==="over_limit")list.data=Array.from({length:101},(_,i)=>({...f.other,id:`txn_page${i}`}));
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test.each(["original_post","earlier_read","retained_read","missing"])("%s request provenance cannot be reused",async kind=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let prior="";
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options),req=(v.lastResponse as {requestId:string}).requestId;
  if(options.stripeAccount)v.lastResponse={requestId:kind==="original_post"?"req_originalPost":kind==="earlier_read"?prior:kind==="retained_read"?f.source.completion.proof.transferReadRequestIds[0]:"",headers:{},statusCode:200};else prior=req;return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test("replaying a retained transfer read is not a fresh original observation",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let n=0;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(++n===1)v.lastResponse.requestId=f.source.completion.proof.transferReadRequestIds[0];return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(f.raw.mock.calls.some(([, , ,o])=>o.stripeAccount)).toBe(false);
});
test("the final context observer is admitted only with its complete 30-second allowance",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let n=0;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(options.stripeAccount&&++n===6)jest.spyOn(Date,"now").mockReturnValue((stamp+35)*1000);return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(f.raw).toHaveBeenCalledTimes(10);
});
test("replacing mutable composition context cannot redirect an admitted read",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;f.c.observeContext.mockImplementation(async()=>f.c.context);
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);f.c.context={...context,platformAccountId:"acct_other"};return v;});
 await expect(f.run()).rejects.toThrow();expect(f.raw).toHaveBeenCalledTimes(1);
});
test("provider errors never cause a retry or financial POST",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(method,path,params,options)=>{if(options.stripeAccount)throw Error("Provider unavailable");return raw(method,path,params,options);});
 await expect(f.run()).rejects.toThrow("Provider unavailable");expect(f.raw).toHaveBeenCalledTimes(5);expect(f.raw.mock.calls.every(([m])=>m==="GET")).toBe(true);
});
test("a slow read drains before the 65-second observation rejects; no next read is admitted",async()=>{
 const f=await fixture(),raw=f.raw.getMockImplementation()!;let completed=false;
 f.raw.mockImplementation(async(method,path,params,options)=>{const v=await raw(method,path,params,options);if(options.stripeAccount){jest.spyOn(Date,"now").mockReturnValue((stamp+65)*1000);completed=true;}return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(completed).toBe(true);expect(f.raw).toHaveBeenCalledTimes(5);
});
