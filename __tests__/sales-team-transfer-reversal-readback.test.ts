import {readTeamBoundTransferReversal,readTeamOriginalTransferForRecovery,type TeamTransferReversalOriginal} from "@/lib/salesTeams/transferReversalReadback";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
const stamp=Math.floor(Date.parse("2026-10-24T20:00:00Z")/1000),id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
beforeEach(()=>{jest.spyOn(Date,"now").mockReturnValue(stamp*1000);});afterEach(()=>{jest.restoreAllMocks();});
function fixture(){
 const scope:TeamOperationScope={scopeId:id(81),scopeKey:"settlement:v1",kind:"transfer",saleId:id(20),creatorId:id(1),actorId:null,workerRunId:id(80)},operationId=teamOperationId(scope);
 const request={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST" as const,path:"/v1/transfers",params:{amount:2000,currency:"usd",destination:"acct_creator",source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${scope.saleId}`,
  metadata:{team_protocol:"creatornet-team-distribution-v1",team_sale_id:scope.saleId!,team_receipt_id:id(30),team_transfer_request_id:scope.scopeId,team_provider_operation_id:operationId,team_beneficiary:"creator"}}};
 const q:TeamTransferRequest={id:scope.scopeId,operation_id:operationId,receipt_id:id(30),sale_id:scope.saleId!,creator_id:scope.creatorId!,beneficiary:"creator",beneficiary_user_id:id(1),destination_id:"acct_creator",amount_cents:2000,receipt_revision:3,original_worker_run_id:id(80),chargeId:"ch_original",approvedRecipientId:"acct_creator",context,request,scope,canceled:false,completed:true,created_at:new Date((stamp-40)*1000).toISOString(),
  operation:{...scope,id:operationId,context,request,status:"bound",idempotency_key:`cn-team-v1:${operationId}`,first_dispatch_at:new Date((stamp-30)*1000).toISOString(),lease_until:null,provider_id:"tr_original",provider_request_id:"req_transferPost"}};
 const recoveryScope:TeamOperationScope={scopeId:id(91),scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:id(90)},recoveryOperationId=teamOperationId(recoveryScope);
 const recoveryRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST" as const,path:"/v1/transfers/tr_original/reversals",params:{amount:500,
  metadata:{team_protocol:"creatornet-team-recovery-v1",team_sale_id:q.sale_id,team_receipt_id:q.receipt_id,team_transfer_request_id:q.id,team_recovery_request_id:id(91),team_provider_operation_id:recoveryOperationId,team_beneficiary:q.beneficiary}}};
 const original:TeamTransferReversalOriginal={id:id(91),amountCents:500,originalWorkerRunId:id(90),transfer:q,operation:{...recoveryScope,id:recoveryOperationId,context,request:recoveryRequest,status:"bound",idempotency_key:`cn-team-v1:${recoveryOperationId}`,first_dispatch_at:new Date((stamp-10)*1000).toISOString(),lease_until:null,provider_id:"trr_original",provider_request_id:"req_reversalPost"}};
 const transfer:Record<string,unknown>={id:"tr_original",object:"transfer",amount:2000,amount_reversed:500,balance_transaction:"txn_transfer",created:stamp-25,currency:"usd",destination:"acct_creator",destination_payment:"py_destination",livemode:false,metadata:request.params.metadata,reversed:false,
  reversals:{object:"list",data:[],has_more:true,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${q.sale_id}`,description:"private transfer description"};
 const reversal:Record<string,unknown>={object:"transfer_reversal",id:"trr_original",transfer:"tr_original",amount:500,currency:"usd",created:stamp-5,balance_transaction:"txn_return",destination_payment_refund:"pyr_original",source_refund:null,metadata:recoveryRequest.params.metadata,description:"private reversal description"};
 const balance:Record<string,unknown>={object:"balance_transaction",id:"txn_return",source:"trr_original",amount:500,fee:12,net:488,currency:"usd",exchange_rate:null,type:"transfer_refund",reporting_category:"transfer_reversal",balance_type:"payments",created:stamp-5,available_on:stamp-1,status:"available",
  fee_details:[{amount:12,currency:"usd",application:null,type:"stripe_fee",description:"private fee description"}],description:"private balance description"};
 const values:Record<string,Record<string,unknown>>={"/v1/transfers/tr_original":transfer,"/v1/transfers/tr_original/reversals/trr_original":reversal,"/v1/balance_transactions/txn_return":balance};let sequence=0;
 const raw=jest.fn(async(method:string,path:string,params:unknown,options:unknown)=>{if(method!=="GET"||!values[path])throw Error("Only saved original reversal GETs are permitted");void params;void options;
  const value:Record<string,unknown>&{lastResponse:{requestId:string;headers:Record<string,string>;statusCode:number}}={...clone(values[path]),lastResponse:{requestId:`req_reversalRead${++sequence}`,headers:{},statusCode:200}};return value;});
 const c={context,observeContext:jest.fn(async()=>context),stripe:{rawRequest:raw}};
 return {q,original,transfer,reversal,balance,raw,c,read:()=>readTeamBoundTransferReversal(c,original)};
}

test.each([0,500,2000])("two original-root GETs preserve %i aggregate without adopting any reversal",async amount=>{
 const f=fixture();f.transfer.amount_reversed=amount;f.transfer.reversed=amount===2000;
 const proof=await readTeamOriginalTransferForRecovery(f.c,f.q);expect(proof.transfer.amountReversedCents).toBe(amount);expect(f.raw).toHaveBeenCalledTimes(2);
 expect(f.raw.mock.calls.map(([method,path])=>[method,path])).toEqual([["GET","/v1/transfers/tr_original"],["GET","/v1/transfers/tr_original"]]);expect(JSON.stringify(proof)).not.toMatch(/private|idempotency|trr_/);
});
test.each(["unknown","uncompleted","canceled","key","context"])("root reader refuses %s original before provider reads",async change=>{
 const f=fixture();if(change==="unknown")f.q.operation!.status="unknown";if(change==="uncompleted")f.q.completed=false;if(change==="canceled")f.q.canceled=true;if(change==="key")f.q.operation!.idempotency_key="foreign";if(change==="context")f.q.context={...context,mode:"live"};
 await expect(readTeamOriginalTransferForRecovery(f.c,f.q)).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});
test.each(["changed","duplicate","late","context"])("root reader refuses %s repeated proof",async change=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let n=0;
 f.c.observeContext.mockImplementation(async()=>f.c.context);
 f.raw.mockImplementation(async(...args)=>{const value=await raw(...args);n++;if(change==="changed"&&n===2)value.amount_reversed=501;if(change==="duplicate")value.lastResponse.requestId="req_duplicate";if(change==="late")jest.spyOn(Date,"now").mockReturnValue(stamp*1000+25000);if(change==="context")f.c.context={...context,platformAccountId:"acct_foreign"};return value;});
 await expect(readTeamOriginalTransferForRecovery(f.c,f.q)).rejects.toThrow(/requires reconciliation/);expect(f.raw.mock.calls.length).toBeLessThanOrEqual(2);
});

test("six independent GETs prove one bound original reversal and its actual returned funds",async()=>{
 const f=fixture(),proof=await f.read();expect(proof).toMatchObject({originalRequestId:"req_reversalPost",transferRequestId:f.q.id,creatorId:f.q.creator_id,
  transfer:{id:"tr_original",amountReversedCents:500},reversal:{id:"trr_original",transferId:"tr_original",amountCents:500},balance:{id:"txn_return",sourceId:"trr_original",amountCents:500,feeCents:12,netCents:488}});
 expect(f.raw.mock.calls.map(([method,path])=>[method,path])).toEqual([["GET","/v1/transfers/tr_original"],["GET","/v1/transfers/tr_original/reversals/trr_original"],["GET","/v1/balance_transactions/txn_return"],["GET","/v1/transfers/tr_original"],["GET","/v1/transfers/tr_original/reversals/trr_original"],["GET","/v1/balance_transactions/txn_return"]]);
 for(const [,,params,options] of f.raw.mock.calls){expect(params).toEqual({});expect(options).toMatchObject({apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000});}
 expect(JSON.stringify(proof)).not.toMatch(/private|bank/i);
});

test.each(["unknown","uncompleted_transfer","canceled_transfer","scope","key","bytes","amount","worker","context"])("changed original %s cannot begin provider reads",async change=>{
 const f=fixture();if(change==="unknown"){f.original.operation.status="unknown";f.original.operation.provider_id=null;}if(change==="uncompleted_transfer")f.q.completed=false;if(change==="canceled_transfer")f.q.canceled=true;
 if(change==="scope")f.original.operation.creatorId=id(2);if(change==="key")f.original.operation.idempotency_key="foreign";if(change==="bytes")f.original.operation.request.params.amount=501;if(change==="amount")f.original.amountCents=501;if(change==="worker")f.original.originalWorkerRunId=id(3);if(change==="context")f.original.operation.context={...context,platformAccountId:"acct_other"};
 await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});

test.each(["destination","source_transaction","transfer_group","amount","currency","livemode","source_type","metadata","created","amount_reversed","reversed"])("foreign or inconsistent original transfer %s is rejected",async field=>{
 const f=fixture();f.transfer[field]=field==="amount"?2001:field==="created"?stamp-100:field==="amount_reversed"?499:field==="reversed"||field==="livemode"?true:field==="metadata"?{}:"foreign";await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test.each(["transfer","id","amount","currency","created","metadata","source_refund","balance_transaction","destination_payment_refund"])("changed reversal %s cannot establish an original return",async field=>{
 const f=fixture();f.reversal[field]=field==="amount"?501:field==="created"?stamp-100:field==="metadata"?{}:"foreign";await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test.each(["source","amount","fee","net","type","balance_type","currency","exchange_rate","available_on","status","fee_details","reporting_category"])("invalid balance return %s remains unproved",async field=>{
 const f=fixture();f.balance[field]=field==="amount"?-500:field==="fee"?-1:field==="net"?500:field==="exchange_rate"?1:field==="available_on"?stamp+1:field==="status"?"pending":field==="fee_details"?[]:field==="reporting_category"?"private invalid category":"foreign";await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test.each(["transfer","reversal","balance"])("a changing repeated %s cannot be credited",async kind=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let count=0;f.raw.mockImplementation(async(...args)=>{const v=await raw(...args);count++;if(kind==="transfer"&&count===4)v.amount_reversed=501;if(kind==="reversal"&&count===5)v.destination_payment_refund=null;if(kind==="balance"&&count===6){v.fee=0;v.net=500;v.fee_details=[];}return v;});await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test.each(["missing","duplicate"])("%s provider request IDs cannot become independent proof",async change=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(...args)=>({...await raw(...args),lastResponse:{requestId:change==="missing"?"":"req_reused",headers:{},statusCode:200}}));await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test("expanded IDs and nullable destination refund are normalized without private fields",async()=>{
 const f=fixture();Object.assign(f.transfer,{destination:{id:"acct_creator",email:"private"},source_transaction:{id:"ch_original"},balance_transaction:{id:"txn_transfer"},destination_payment:{id:"py_destination"}});Object.assign(f.reversal,{transfer:{id:"tr_original"},balance_transaction:{id:"txn_return"},destination_payment_refund:null});f.balance.source={id:"trr_original"};expect((await f.read()).reversal.destinationPaymentRefundId).toBeNull();
});

test("actual cost exceeding returned principal is retained as actual negative net without debt accounting",async()=>{
 const f=fixture();f.balance.fee=600;f.balance.net=-100;f.balance.fee_details=[{amount:600,currency:"usd",application:null,type:"stripe_fee"}];expect((await f.read()).balance).toMatchObject({amountCents:500,feeCents:600,netCents:-100});
});

test("context drift prevents the first GET",async()=>{
 const f=fixture();f.c.observeContext.mockResolvedValue({...context,platformAccountId:"acct_other"});await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});

test("a mutable composition context cannot replace the frozen account mid-read",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.c.observeContext.mockImplementation(async()=>f.c.context);f.raw.mockImplementation(async(...args)=>{const v=await raw(...args);f.c.context={...context,platformAccountId:"acct_other"};return v;});await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).toHaveBeenCalledTimes(1);
});

test("a late GET cannot outlive the bounded observation and start more requests",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(...args)=>{const v=await raw(...args);jest.spyOn(Date,"now").mockReturnValue(stamp*1000+25000);return v;});await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).toHaveBeenCalledTimes(1);
});

test("a fully reversed original retains the same exact return and principal proof",async()=>{
 const f=fixture();f.original.amountCents=2000;f.original.operation.request.params.amount=2000;f.transfer.amount_reversed=2000;f.transfer.reversed=true;f.reversal.amount=2000;f.balance.amount=2000;f.balance.net=1988;
 expect((await f.read()).transfer).toMatchObject({reversed:true,amountCents:2000,amountReversedCents:2000});
});

test.each([0,-1,2001,0.5])("invalid original recovery amount %s stops before transport",async amount=>{
 const f=fixture();f.original.amountCents=amount;f.original.operation.request.params.amount=amount;await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});

test.each(["application","currency","type","negative"])("unsupported actual return fee %s cannot become creator cost",async change=>{
 const f=fixture(),fee=(f.balance.fee_details as Record<string,unknown>[])[0];if(change==="application")fee.application="ca_foreign";if(change==="currency")fee.currency="eur";if(change==="type")fee.type="application_fee";if(change==="negative"){fee.amount=-12;f.balance.fee=-12;f.balance.net=512;}
 await expect(f.read()).rejects.toThrow(/requires reconciliation/);
});

test("the actual reporting classification is carried without inventing an accounting default",async()=>{
 const f=fixture();f.balance.reporting_category="transfer";expect((await f.read()).balance.reportingCategory).toBe("transfer");
});

test("a purported reversal predating its provider transfer cannot establish returned principal",async()=>{
 const f=fixture();f.original.operation.first_dispatch_at=new Date((stamp-30)*1000).toISOString();f.reversal.created=stamp-26;f.balance.created=stamp-26;
 await expect(f.read()).rejects.toThrow(/requires reconciliation/);expect(f.raw).toHaveBeenCalledTimes(2);
});
