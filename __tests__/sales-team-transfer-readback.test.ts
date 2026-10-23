import {readTeamBoundTransfer,recoverTeamUnknownTransfer} from "@/lib/salesTeams/transferReadback";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
const stamp=Math.floor(Date.parse("2026-10-23T18:30:00Z")/1000),uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.spyOn(Date,"now").mockReturnValue(stamp*1000);});afterEach(()=>{jest.restoreAllMocks();});
function fixture(){
 const scope:TeamOperationScope={scopeId:uuid(81),scopeKey:"settlement:v1",kind:"transfer",saleId:uuid(20),creatorId:uuid(1),actorId:null,workerRunId:uuid(80)},operationId=teamOperationId(scope);
 const request={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST" as const,path:"/v1/transfers",params:{amount:2000,currency:"usd",destination:"acct_creator",source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${scope.saleId}`,
  metadata:{team_protocol:"creatornet-team-distribution-v1",team_sale_id:scope.saleId!,team_receipt_id:uuid(30),team_transfer_request_id:scope.scopeId,team_provider_operation_id:operationId,team_beneficiary:"creator"}}};
 const q:TeamTransferRequest={id:scope.scopeId,operation_id:operationId,receipt_id:uuid(30),sale_id:scope.saleId!,creator_id:scope.creatorId!,beneficiary:"creator",beneficiary_user_id:uuid(1),destination_id:"acct_creator",amount_cents:2000,receipt_revision:3,original_worker_run_id:uuid(80),chargeId:"ch_original",approvedRecipientId:"acct_creator",context,request,scope,canceled:false,completed:false,created_at:new Date((stamp-30)*1000).toISOString(),
  operation:{...scope,id:operationId,context,request,status:"bound",idempotency_key:`cn-team-v1:${operationId}`,first_dispatch_at:new Date((stamp-20)*1000).toISOString(),lease_until:null,provider_id:"tr_original",provider_request_id:"req_originalPost"}};
 const transfer={id:"tr_original",object:"transfer",amount:2000,amount_reversed:0,balance_transaction:"txn_transfer",created:stamp-15,currency:"usd",destination:"acct_creator",destination_payment:"py_destination",livemode:false,metadata:request.params.metadata,
  reversed:false,reversals:{object:"list",data:[],has_more:false,total_count:0,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${scope.saleId}`,description:"private provider text"};
 const balance={id:"txn_transfer",object:"balance_transaction",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",amount:-2000,fee:12,net:-2012,exchange_rate:null,created:stamp-15,available_on:stamp-10,status:"available",
  fee_details:[{amount:12,currency:"usd",application:null,type:"stripe_fee",description:"private fee text"}],description:"private balance text"};
 const event={id:"evt_original",object:"event",type:"transfer.created",account:null as string|null,livemode:false,created:stamp-15,request:{id:"req_originalPost",idempotency_key:q.operation!.idempotency_key},data:{object:structuredClone(transfer)}};
 const values:Record<string,Record<string,unknown>>={"/v1/transfers/tr_original":transfer,"/v1/balance_transactions/txn_transfer":balance,"/v1/events":{object:"list",data:[event],has_more:false}};
 let n=0;const raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||!values[path])throw Error("Only original transfer GETs are permitted");const value:Record<string,unknown>&{lastResponse:{requestId:string;headers:Record<string,string>;statusCode:number}}={...structuredClone(values[path]),lastResponse:{requestId:`req_read${++n}`,headers:{},statusCode:200}};return value;});
 const c={context,observeContext:jest.fn(async()=>context),stripe:{rawRequest:raw}};
 const unknown=()=>{q.operation!.status="unknown";q.operation!.provider_id=null;q.operation!.provider_request_id=null;return recoverTeamUnknownTransfer(c,q);};
 return {q,c,raw,values,transfer,balance,event,unknown,bound:()=>readTeamBoundTransfer(c,q)};
}
test("a bound original proves its exact transfer and actual platform debit through repeat independent GETs",async()=>{
 const f=fixture(),proof=await f.bound();expect(proof).toMatchObject({originalRequestId:"req_originalPost",transfer:{id:"tr_original",sourceChargeId:"ch_original",amountCents:2000,destinationId:"acct_creator"},balance:{id:"txn_transfer",sourceId:"tr_original",amountCents:-2000,feeCents:12,netCents:-2012}});
 expect(f.raw.mock.calls.map(([method,path])=>[method,path])).toEqual([["GET","/v1/transfers/tr_original"],["GET","/v1/balance_transactions/txn_transfer"],["GET","/v1/transfers/tr_original"],["GET","/v1/balance_transactions/txn_transfer"]]);
 expect(JSON.stringify(proof)).not.toContain("private");expect(JSON.stringify(proof)).not.toContain("bank");
});
test.each(["destination","source_transaction","transfer_group","amount","currency","livemode","source_type","metadata","created","balance_transaction","destination_payment"])("a changed transfer %s cannot be attributed to the saved original",async field=>{
 const f=fixture();(f.transfer as Record<string,unknown>)[field]=field==="amount"?2001:field==="created"?stamp-100:field==="livemode"?true:field==="metadata"?{}:"foreign";
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test.each(["partial","full","hidden","incomplete"])("%s reversal evidence prevents a completed-transfer proof",async kind=>{
 const f=fixture();if(kind==="partial")f.transfer.amount_reversed=1;if(kind==="full"){f.transfer.reversed=true;f.transfer.amount_reversed=2000;}if(kind==="hidden")f.transfer.reversals.total_count=1;if(kind==="incomplete")f.transfer.reversals.has_more=true;
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);expect(f.raw.mock.calls.some(([,p])=>p.includes("balance_transactions"))).toBe(false);
});
test.each(["source","amount","fee","net","type","reporting_category","balance_type","currency","exchange_rate","available_on","status","fee_details"])("an unrelated or incomplete debit %s cannot establish settlement",async field=>{
 const f=fixture();(f.balance as Record<string,unknown>)[field]=field==="amount"?2000:field==="fee"?-1:field==="net"?-2000:field==="exchange_rate"?1:field==="available_on"?stamp+1:field==="status"?"pending":field==="fee_details"?[]:"foreign";
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test("expanded provider IDs are normalized without persisting their private object data",async()=>{
 const f=fixture();Object.assign(f.transfer,{destination:{id:"acct_creator",email:"private"},source_transaction:{id:"ch_original",billing_details:"private"},balance_transaction:{id:"txn_transfer"},destination_payment:{id:"py_destination"}});Object.assign(f.balance,{source:{id:"tr_original"}});
 expect((await f.bound()).transfer.destinationId).toBe("acct_creator");
});
test("a changing transfer between independent reads remains unresolved",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let count=0;f.raw.mockImplementation(async(method,path)=>{const v=await raw(method,path);if(path.includes("transfers")&&++count===2)v.created=stamp-14;return v;});
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test("a changing owned debit between reads remains unresolved",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let count=0;f.raw.mockImplementation(async(method,path)=>{const v=await raw(method,path);if(path.includes("balance_transactions")&&++count===2){v.fee=0;v.net=-2000;v.fee_details=[];}return v;});
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test.each(["duplicate","missing"])("%s independent request IDs cannot produce a proof",async kind=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(method,path)=>({...await raw(method,path),lastResponse:{requestId:kind==="duplicate"?"req_reused":"",headers:{},statusCode:200}}));await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test("context drift halts original reads",async()=>{
 const f=fixture();f.c.observeContext.mockResolvedValue({...context,platformAccountId:"acct_other"});await expect(f.bound()).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});
test("replacing the mutable composition context cannot change the expected account mid-read",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.c.observeContext.mockImplementation(async()=>f.c.context);
 f.raw.mockImplementation(async(method,path)=>{const v=await raw(method,path);f.c.context={...context,platformAccountId:"acct_other"};return v;});
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);expect(f.raw).toHaveBeenCalledTimes(1);
});
test("the standard complete empty reversal list is accepted without the optional legacy count",async()=>{
 const f=fixture();delete (f.transfer.reversals as {total_count?:number}).total_count;expect((await f.bound()).transfer.amountReversedCents).toBe(0);
});
test.each(["foreign_fee","negative_fee","currency","application"])("unsupported actual transfer fee evidence (%s) remains held",async field=>{
 const f=fixture(),fee=f.balance.fee_details[0];if(field==="foreign_fee")fee.type="application_fee";if(field==="negative_fee")fee.amount=-12;if(field==="currency")fee.currency="eur";if(field==="application")Object.assign(fee,{application:"ca_foreign"});
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test("the total observation budget is bounded even when a GET itself eventually returns",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(method,path)=>{const value=await raw(method,path);jest.spyOn(Date,"now").mockReturnValue(stamp*1000+25000);return value;});await expect(f.bound()).rejects.toThrow(/requires reconciliation/);
});
test("an uncertain original resolves only from its original event request key and repeated exact debit reads",async()=>{
 const f=fixture(),proof=await f.unknown();expect(proof).toMatchObject({originalRequestId:"req_originalPost",recovery:{eventId:"evt_original",eventType:"transfer.created",account:null},transfer:{id:"tr_original"}});
 expect(f.raw.mock.calls).toHaveLength(5);expect(f.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(f.q.operation!.status).toBe("unknown");expect(f.q.operation!.provider_id).toBeNull();
});
test("matching metadata without the original event idempotency key is never adopted",async()=>{
 const f=fixture();f.event.request.idempotency_key="foreign";expect(await f.unknown()).toBeNull();expect(f.raw).toHaveBeenCalledTimes(1);
});
test("duplicate matching original events remain ambiguous",async()=>{
 const f=fixture();f.values["/v1/events"].data=[f.event,{...f.event,id:"evt_duplicate"}];expect(await f.unknown()).toBeNull();expect(f.raw).toHaveBeenCalledTimes(1);
});
test.each(["account","mode","request","created","snapshot"])("a foreign event %s cannot establish original transfer ownership",async field=>{
 const f=fixture();if(field==="account")f.event.account="acct_other";if(field==="mode")f.event.livemode=true;if(field==="request")f.event.request.id="bad";if(field==="created")f.event.created=stamp-100;if(field==="snapshot")f.event.data.object.destination="acct_foreign";
 await expect(f.unknown()).rejects.toThrow(/requires reconciliation/);
});
test("an event snapshot differing from the current original cannot be rebound",async()=>{
 const f=fixture();f.event.data.object.created=stamp-14;await expect(f.unknown()).rejects.toThrow(/requires reconciliation/);
});
test("incomplete event pagination stays bounded and never issues an invented POST",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let page=0;f.raw.mockImplementation(async(method,path)=>{const v=await raw(method,path);if(path==="/v1/events"){v.data=[{...f.event,id:`evt_page${++page}`}];v.has_more=true;}return v;});expect(await f.unknown()).toBeNull();expect(f.raw).toHaveBeenCalledTimes(3);
});
test("a live original dispatch lease cannot be stolen by unknown recovery",async()=>{
 const f=fixture();Object.assign(f.q.operation!,{status:"dispatching",provider_id:null,provider_request_id:null,lease_until:new Date((stamp+60)*1000).toISOString()});
 await expect(recoverTeamUnknownTransfer(f.c,f.q)).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});
test("an expired dispatch lease can observe only its original event",async()=>{
 const f=fixture();Object.assign(f.q.operation!,{status:"dispatching",provider_id:null,provider_request_id:null,lease_until:new Date((stamp-1)*1000).toISOString()});expect(await recoverTeamUnknownTransfer(f.c,f.q)).toMatchObject({recovery:{eventId:"evt_original"}});
});
test.each(["none","worker","request","key","canceled"])("a changed or absent original journal (%s) permits no provider reads",async field=>{
 const f=fixture();if(field==="none")f.q.operation=null;if(field==="worker")f.q.operation!.workerRunId=uuid(83);if(field==="request")f.q.operation!.request={...f.q.request,params:{...f.q.request.params,amount:1}};if(field==="key")f.q.operation!.idempotency_key="foreign";if(field==="canceled")f.q.canceled=true;
 await expect(f.bound()).rejects.toThrow(/requires reconciliation/);expect(f.raw).not.toHaveBeenCalled();
});
