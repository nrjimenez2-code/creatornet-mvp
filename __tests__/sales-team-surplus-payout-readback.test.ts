import type Stripe from "stripe";
import {teamSurplusPayoutFixture} from "@/test-support/sales-team-surplus-payout-fixture";
import {readTeamSurplusDestination,readTeamSurplusPayout} from "@/lib/salesTeams/surplusPayoutReadback";
function fixture(){
 const f=teamSurplusPayoutFixture();let sequence=0;
 const raw=jest.fn(async(method:string,path:string,_params?:unknown,_options?:unknown)=>{
  void _params;void _options;
  if(method!=="GET")throw Error("Payout readback fixture rejects POST");
  const value=path==="/v1/account"?f.account:path==="/v1/balance_settings"?f.settings:path===`/v1/accounts/acct_platform/external_accounts/${f.q.destination_id}`?f.bank:path==="/v1/payouts/po_original"?f.payout:path==="/v1/balance_transactions/txn_debit"?f.debit:path==="/v1/balance_transactions/txn_return"?f.returned:null;
  if(!value)throw Error(path);return {...value,lastResponse:{requestId:`req_originalRead${++sequence}`}};
 });
 const observeContext=jest.fn(async()=>f.q.context),c={context:f.q.context,observeContext,stripe:{rawRequest:raw as unknown as Stripe["rawRequest"]}};
 return {...f,c,raw,observeContext};
}

test("fresh eligibility reads only the approved platform, settings and bank with a fixed API pin",async()=>{
 const f=fixture(),proof=await readTeamSurplusDestination(f.c,f.q);
 expect(proof).toMatchObject({destinationId:"ba_approved",manualPayouts:true,payoutsEnabled:true,policyRevision:1});
 expect(f.raw.mock.calls.map(([method,path])=>[method,path])).toEqual([["GET","/v1/account"],["GET","/v1/balance_settings"],["GET","/v1/accounts/acct_platform/external_accounts/ba_approved"]]);
 for(const call of f.raw.mock.calls)expect(call[3]).toMatchObject({apiVersion:"2026-08-26.dahlia",maxNetworkRetries:0,timeout:expect.any(Number)});
});

test("an original is independently bracketed around its exact debit without mutable bank checks",async()=>{
 const f=fixture();f.bank.status="errored";f.account.payouts_enabled=false;
 expect(await readTeamSurplusPayout(f.c,f.q,"po_original")).toMatchObject({complete:true,disposition:"debit_observed",bankConfirmed:false,requestId:f.q.id,operationId:f.q.operation_id});
 expect(f.raw.mock.calls.map(([,path])=>path)).toEqual(["/v1/payouts/po_original","/v1/balance_transactions/txn_debit","/v1/payouts/po_original"]);
});

test("a failed payout reads the independently linked debit and returned principal",async()=>{
 const f=fixture();f.payout.status="failed";f.payout.failure_balance_transaction="txn_return";
 expect(await readTeamSurplusPayout(f.c,f.q,"po_original")).toMatchObject({complete:true,disposition:"returned",bankConfirmed:false});expect(f.raw).toHaveBeenCalledTimes(4);
});

test("a different original ID is rejected before provider transport",async()=>{
 const f=fixture();await expect(readTeamSurplusPayout(f.c,f.q,"po_foreign")).rejects.toThrow(/readback requires review/);expect(f.raw).not.toHaveBeenCalled();
});

test("a changed payout state during balance inspection holds the original",async()=>{
 const f=fixture(),original=f.raw.getMockImplementation()!;let reads=0;
 f.raw.mockImplementation(async(method,path,params,options)=>{const value=await original(method,path,params,options);if(path==="/v1/payouts/po_original"&&++reads===2)return {...value,status:"paid"};return value;});
 await expect(readTeamSurplusPayout(f.c,f.q,"po_original")).rejects.toThrow(/readback requires review/);expect(f.raw).toHaveBeenCalledTimes(3);
});

test.each(["before","after"])("context drift %s original inspection prevents a proof",async when=>{
 const f=fixture();if(when==="before")f.observeContext.mockResolvedValue({...f.q.context,platformAccountId:"acct_foreign"});else f.observeContext.mockResolvedValueOnce(f.q.context).mockResolvedValue({...f.q.context,platformAccountId:"acct_foreign"});
 await expect(readTeamSurplusPayout(f.c,f.q,"po_original")).rejects.toThrow(/readback requires review/);if(when==="before")expect(f.raw).not.toHaveBeenCalled();
});

test("duplicate provider request IDs cannot masquerade as independent reads",async()=>{
 const f=fixture(),original=f.raw.getMockImplementation()!;f.raw.mockImplementation(async(method,path,params,options)=>({...await original(method,path,params,options),lastResponse:{requestId:"req_reused"}}));
 await expect(readTeamSurplusPayout(f.c,f.q,"po_original")).rejects.toThrow(/readback requires review/);
});

test.each([45000,-1])("the %i-ms observation boundary starts no follow-up transport",async elapsed=>{
 const f=fixture(),original=f.raw.getMockImplementation()!,base=Date.now();let clock=base;
 f.raw.mockImplementation(async(method,path,params,options)=>{const value=await original(method,path,params,options);clock=base+elapsed;return value;});
 await expect(readTeamSurplusPayout(f.c,f.q,"po_original",{now:()=>clock})).rejects.toThrow(/readback requires review/);expect(f.raw).toHaveBeenCalledTimes(1);
});

test("parallel eligibility requests drain before a failure is returned",async()=>{
 const f=fixture(),original=f.raw.getMockImplementation()!;let release!:()=>void,entered!:()=>void,settled=false;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 f.raw.mockImplementation(async(method,path,params,options)=>{if(path==="/v1/account"){entered();await held;}if(path==="/v1/balance_settings")throw Error("synthetic settings failure");return original(method,path,params,options);});
 const read=readTeamSurplusDestination(f.c,f.q).finally(()=>{settled=true;});await started;await Promise.resolve();expect(settled).toBe(false);release();await expect(read).rejects.toThrow(/synthetic settings failure/);
});
