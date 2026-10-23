import {readSharedCashOriginal,type SharedCashOriginal} from "@/lib/salesTeams/sharedCashReadback";
const stamp=Math.floor(Date.parse("2026-10-22T20:00:00Z")/1000);
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const original:SharedCashOriginal={kind:"legacy_refund",id:"00000000-0000-4000-8000-000000000091",creatorId:"00000000-0000-4000-8000-000000000001",context,fingerprint:"a".repeat(64),createdAt:stamp-100,closed:true,
 chargeId:"ch_original",paymentIntentId:"pi_original",grossCents:10000,refundCents:1000,refundId:"re_original",applicationFeeId:"fee_original",feeRefundId:"fr_original",feeRefundCents:120,actualFeeRefundCents:120,responsibility:"creator",reasonCode:"creator_discretionary"};
const balance=(id:string,source:string,type:string,amount:number,fee=0)=>({id,object:"balance_transaction",source,type,amount,fee,net:amount-fee,currency:"usd",exchange_rate:null,balance_type:"payments",created:stamp-10,available_on:stamp-5,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]});
function fixture(s:SharedCashOriginal=original){
 const values:Record<string,Record<string,unknown>>={
  "/v1/charges/ch_original":{object:"charge",id:"ch_original",payment_intent:"pi_original",livemode:false,currency:"usd",paid:true,captured:true,status:"succeeded",amount:10000,application_fee:"fee_original",transfer:"tr_original",transfer_data:{destination:"acct_creator"}},
  "/v1/refunds/re_original":{object:"refund",id:"re_original",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"succeeded",created:stamp-10,balance_transaction:"txn_refund",failure_balance_transaction:null,metadata:{creatornet_refund_operation_id:original.id,responsibility:"creator",reason_code:"creator_discretionary"},description:"private material must not be stored"},
  "/v1/application_fees/fee_original":{object:"application_fee",id:"fee_original",charge:"ch_original",account:"acct_creator",currency:"usd",livemode:false,amount:1520,amount_refunded:120},
  "/v1/application_fees/fee_original/refunds/fr_original":{object:"fee_refund",id:"fr_original",fee:"fee_original",amount:120,currency:"usd",created:stamp-10,balance_transaction:"txn_fee",metadata:{creatornet_refund_operation_id:original.id,responsibility:"creator"}},
  "/v1/balance_transactions/txn_refund":balance("txn_refund","re_original","refund",-1000,40),
  "/v1/balance_transactions/txn_fee":balance("txn_fee","fr_original","application_fee_refund",-120),
 };
 let count=0;const raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||!values[path])throw Error("Only owned original GETs are permitted");const response:Record<string,unknown>&{lastResponse:{requestId:string}}={...structuredClone(values[path]),lastResponse:{requestId:`req_read${++count}`}};return response;});
 const c={context,observeContext:async()=>context,stripe:{rawRequest:raw}};
 return {values,raw,c,run:()=>readSharedCashOriginal(c,s,()=>stamp*1000)};
}
test("known legacy originals independently prove their actual customer and application-fee debits",async()=>{
 const f=fixture(),proof=await f.run();expect(proof.complete).toBe(true);expect(proof.balances).toEqual([expect.objectContaining({id:"txn_fee",sourceId:"fr_original",amountCents:-120}),expect.objectContaining({id:"txn_refund",sourceId:"re_original",amountCents:-1000,feeCents:40})]);
 expect(f.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(f.raw.mock.calls.length).toBeLessThanOrEqual(16);expect(JSON.stringify(proof)).not.toContain("private material");
});
test("unknown provider identities and unfinished old workflows retain commitments without metadata adoption",async()=>{
 const unknown=fixture({...original,refundId:null});expect(await unknown.run()).toMatchObject({complete:false,holdReason:"original_provider_identity_required"});expect(unknown.raw).not.toHaveBeenCalled();
 const unfinished=fixture({...original,closed:false});expect(await unfinished.run()).toMatchObject({complete:false,holdReason:"original_workflow_unfinished"});expect(unfinished.raw).not.toHaveBeenCalled();
});
test("a pending original refund does not release cash or read an imagined debit",async()=>{
 const f=fixture();f.values["/v1/refunds/re_original"].status="pending";
 expect(await f.run()).toMatchObject({complete:false,holdReason:"original_refund_pending"});expect(f.raw.mock.calls.some(([,path])=>path.startsWith("/v1/balance_transactions"))).toBe(false);
});
test("a failed original follows the actual owned refund debit and failure credit",async()=>{
 const f=fixture({...original,feeRefundId:null,feeRefundCents:0,actualFeeRefundCents:null});f.values["/v1/refunds/re_original"].status="failed";f.values["/v1/refunds/re_original"].failure_balance_transaction="txn_return";
 f.values["/v1/balance_transactions/txn_return"]=balance("txn_return","re_original","refund_failure",1000,-10);
 const proof=await f.run();expect(proof.complete).toBe(true);expect(proof.balances.reduce((sum,e)=>sum+e.amountCents,0)).toBe(0);expect(proof.balances.reduce((sum,e)=>sum+e.feeCents,0)).toBe(30);
});
test.each(["source","status","net","balance_type"])("unsupported or changed balance %s retains the commitment",async field=>{
 const f=fixture();f.values["/v1/balance_transactions/txn_refund"][field]=field==="net"?-999:field==="status"?"pending":field==="balance_type"?"issuing":"re_foreign";
 await expect(f.run()).rejects.toThrow(/evidence requires review/);
});
test("a late refund transition cannot produce a mixed successful cash proof",async()=>{
 const f=fixture(),base=f.raw.getMockImplementation()!;let reads=0;
 f.raw.mockImplementation(async(method,path)=>{const value=await base(method,path);if(path==="/v1/refunds/re_original"&&++reads===2)value.status="failed";return value;});
 await expect(f.run()).rejects.toThrow(/evidence requires review/);
});

test.each(["charge","account","mode","amount","refunded"])("application-fee parent %s must independently match its owned refund",async field=>{
 const f=fixture(),parent=f.values["/v1/application_fees/fee_original"];
 if(field==="charge")parent.charge="ch_foreign";
 if(field==="account")parent.account="acct_foreign";
 if(field==="mode")parent.livemode=true;
 if(field==="amount")parent.amount=0;
 if(field==="refunded")parent.amount_refunded=1;
 await expect(f.run()).rejects.toThrow(/evidence requires review/);
});

test("repeated provider responses cannot impersonate two independent GETs",async()=>{
 const f=fixture(),base=f.raw.getMockImplementation()!;
 f.raw.mockImplementation(async(method,path)=>({...await base(method,path),lastResponse:{requestId:"req_reused"}}));await expect(f.run()).rejects.toThrow(/evidence requires review/);
});

test("the final context read stays inside the same bounded observation budget",async()=>{
 const f=fixture();let now=stamp*1000;
 f.c.observeContext=async()=>{if(f.raw.mock.calls.length>0)now+=45000;return context;};
 await expect(readSharedCashOriginal(f.c,original,()=>now)).rejects.toThrow(/evidence requires review/);
});
test("all admitted balance GETs finish before a failed trace is returned",async()=>{
 const f=fixture(),base=f.raw.getMockImplementation()!;let feeReadCompleted=false;
 f.raw.mockImplementation(async(method,path)=>{if(path==="/v1/balance_transactions/txn_refund")throw Error("synthetic refund balance read failure");const value=await base(method,path);if(path==="/v1/balance_transactions/txn_fee"){await Promise.resolve();feeReadCompleted=true;}return value;});
 await expect(f.run()).rejects.toThrow(/synthetic refund balance/);expect(feeReadCompleted).toBe(true);
});
test("a known tip restoration proves a platform transfer debit without asserting a bank payout",async()=>{
 const s:SharedCashOriginal={kind:"tip_restoration",id:"dp_original",disputeId:"dp_original",creatorId:original.creatorId,context,fingerprint:"b".repeat(64),createdAt:stamp-100,closed:true,chargeId:"ch_original",paymentIntentId:"pi_original",
  tipId:"00000000-0000-4000-8000-000000000092",originalTransferId:"tr_original",restorationTransferId:"tr_restored",destinationId:"acct_creator",restorationCents:500};
 const f=fixture(s);f.values["/v1/disputes/dp_original"]={object:"dispute",id:"dp_original",charge:"ch_original",payment_intent:"pi_original",currency:"usd",livemode:false,status:"won"};
 f.values["/v1/transfers/tr_restored"]={object:"transfer",id:"tr_restored",amount:500,currency:"usd",livemode:false,destination:"acct_creator",source_transaction:null,source_type:"card",transfer_group:"creatornet-tip-dispute-restore:dp_original",created:stamp-10,balance_transaction:"txn_transfer",metadata:{payment_kind:"video_tip_dispute_restoration",tip_id:s.tipId,dispute_id:s.disputeId}};
 f.values["/v1/balance_transactions/txn_transfer"]=balance("txn_transfer","tr_restored","transfer",-500);
 const proof=await f.run();expect(proof.complete).toBe(true);expect(proof.balances).toEqual([expect.objectContaining({id:"txn_transfer",amountCents:-500})]);expect(proof).not.toHaveProperty("bankPayoutStatus");
});
