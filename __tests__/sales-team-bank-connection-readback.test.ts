import {readTeamBankConnection,TEAM_BANK_FEED_MAX_AGE_SECONDS,type TeamBankConnectionSource} from "@/lib/salesTeams/bankConnectionReadback";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
const stamp=Math.floor(Date.parse("2026-10-29T20:00:00Z")/1000),uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.spyOn(Date,"now").mockReturnValue(stamp*1000);});afterEach(()=>{jest.restoreAllMocks();});
function fixture(){
 const source:TeamBankConnectionSource={connectionId:uuid(1),ownerUserId:uuid(2),context,connectedAccountId:"acct_creator",financialAccountId:"fca_original"};
 const account={id:"fca_original",object:"financial_connections.account",account_holder:{type:"account",account:"acct_creator",customer:null as string|null},livemode:false,created:stamp-200000,status:"active",category:"cash",subcategory:"checking",
  permissions:["transactions"],subscriptions:["transactions"],transaction_refresh:{id:"fctxnref_original",last_attempted_at:stamp-120,next_refresh_available_at:stamp+3600 as number|null,status:"succeeded"} as {id:string;last_attempted_at:number;next_refresh_available_at:number|null;status:string}|null,
  institution_name:"private institution",display_name:"private account name",last4:"6789",balance:{cash:{available:{usd:123456}}},account_numbers:[{private:"account data"}],ownership:"private ownership"};
 let n=0;const raw=jest.fn(async()=>({...structuredClone(account),lastResponse:{requestId:`req_bank${++n}`,headers:{},statusCode:200}}));
 const c={context,observeContext:jest.fn(async()=>context),stripe:{rawRequest:raw}};
 return {source,account,raw,c,run:()=>readTeamBankConnection(c,source)};
}
test("repeated account-scoped observations report consent and freshness without retaining private bank data",async()=>{
 const f=fixture(),before=structuredClone(f.source),proof=await f.run();expect(proof).toMatchObject({financialAccountId:"fca_original",connectedAccountId:"acct_creator",health:"ready",transactionsPermitted:true,transactionsSubscribed:true,
  refresh:{id:"fctxnref_original",status:"succeeded",lastAttemptedAt:stamp-120},maxAgeSeconds:129600,bankConfirmed:false});
 expect(f.source).toEqual(before);expect(f.raw).toHaveBeenCalledTimes(2);expect(f.raw).toHaveBeenCalledWith("GET","/v1/financial_connections/accounts/fca_original",{},
  {apiVersion:TEAM_STRIPE_API_VERSION,stripeAccount:"acct_creator",maxNetworkRetries:0,timeout:10000});
 expect(JSON.stringify(proof)).not.toMatch(/private|6789|123456|institution_name|display_name|account_numbers|ownership/);
});
test.each(["disconnected","reconnect_required","unsupported_account","permission_required","subscription_required","refresh_required","refresh_pending","refresh_failed","stale"])("%s is explicit and never reads transaction data",async health=>{
 const f=fixture();if(health==="disconnected")f.account.status="disconnected";if(health==="reconnect_required")f.account.status="inactive";
 if(health==="unsupported_account")f.account.category="credit";if(health==="permission_required")f.account.permissions=[];if(health==="subscription_required")f.account.subscriptions=[];
 if(health==="refresh_required")f.account.transaction_refresh=null;if(health==="refresh_pending")Object.assign(f.account.transaction_refresh!,{status:"pending",next_refresh_available_at:null});
 if(health==="refresh_failed")f.account.transaction_refresh!.status="failed";if(health==="stale")f.account.transaction_refresh!.last_attempted_at=stamp-TEAM_BANK_FEED_MAX_AGE_SECONDS-1;
 expect(await f.run()).toMatchObject({health,bankConfirmed:false});expect(f.raw).toHaveBeenCalledTimes(2);
});
test("a revoked account takes priority over otherwise successful historical refresh data",async()=>{
 const f=fixture();f.account.status="disconnected";expect((await f.run()).health).toBe("disconnected");
});
test("latest failed refresh does not masquerade as the last successful sync",async()=>{
 const f=fixture();f.account.transaction_refresh!.status="failed";const proof=await f.run();expect(proof.health).toBe("refresh_failed");expect(proof).not.toHaveProperty("lastSyncedAt");
});
test.each(["connection","owner","context","platform","account_path","financial_path"])("invalid source %s is rejected before provider access",async kind=>{
 const f=fixture();if(kind==="connection")f.source.connectionId="bad";if(kind==="owner")f.source.ownerUserId="bad";if(kind==="context")f.source.context={...context,platformAccountId:"acct_foreign"};
 if(kind==="platform")f.source.connectedAccountId="acct_platform";if(kind==="account_path")f.source.connectedAccountId="acct_/foreign";if(kind==="financial_path")f.source.financialAccountId="fca_/foreign";
 await expect(f.run()).rejects.toThrow();expect(f.raw).not.toHaveBeenCalled();
});
test.each(["object","id","holder","holder_type","customer","mode","status","category","created","permissions","subscriptions","refresh_id","future","before_creation","refresh_status","pending_next"])("foreign or malformed %s cannot produce connection evidence",async kind=>{
 const f=fixture(),a=f.account;if(kind==="object")a.object="account";if(kind==="id")a.id="fca_other";if(kind==="holder")a.account_holder.account="acct_other";if(kind==="holder_type")a.account_holder.type="customer";
 if(kind==="customer")a.account_holder.customer="cus_foreign";if(kind==="mode")a.livemode=true;if(kind==="status")a.status="unknown";if(kind==="category")a.category="unknown";if(kind==="created")a.created=stamp+100;
 if(kind==="permissions")a.permissions=["transactions","transactions"];if(kind==="subscriptions")a.subscriptions=["unknown"];if(kind==="refresh_id")a.transaction_refresh!.id="other";
 if(kind==="future")a.transaction_refresh!.last_attempted_at=stamp+100;if(kind==="before_creation")a.transaction_refresh!.last_attempted_at=a.created-1;if(kind==="refresh_status")a.transaction_refresh!.status="unknown";
 if(kind==="pending_next")a.transaction_refresh!.status="pending";await expect(f.run()).rejects.toThrow(/requires review/);
});
test.each(["status","permissions","refresh","request_id"])("a changing %s between reads stays unresolved",async kind=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let n=0;
 f.raw.mockImplementation(async()=>{const v=await raw();if(++n===2){if(kind==="status")v.status="inactive";if(kind==="permissions")v.permissions=[];if(kind==="refresh")v.transaction_refresh!.id="fctxnref_other";if(kind==="request_id")v.lastResponse.requestId="req_bank1";}return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test("all granted permissions are observed for drift even if transaction access remains granted",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;let n=0;f.raw.mockImplementation(async()=>{const v=await raw();if(++n===2)v.permissions.push("balances");return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);
});
test("an equivalent permission ordering is stable",async()=>{
 const f=fixture();f.account.permissions=["transactions","balances"];const raw=f.raw.getMockImplementation()!;let n=0;f.raw.mockImplementation(async()=>{const v=await raw();if(++n===2)v.permissions.reverse();return v;});
 expect((await f.run()).health).toBe("ready");
});
test("context changes are rejected without exposing foreign data",async()=>{
 const f=fixture();f.c.observeContext.mockResolvedValue({...context,platformAccountId:"acct_foreign"});await expect(f.run()).rejects.toThrow(/requires review/);expect(f.raw).not.toHaveBeenCalled();
});
test("changing the mutable context after the first read cannot redirect the second",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.c.observeContext.mockImplementation(async()=>f.c.context);f.raw.mockImplementation(async()=>{const v=await raw();f.c.context={...context,platformAccountId:"acct_foreign"};return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(f.raw).toHaveBeenCalledTimes(2);
});
test("a provider timeout is not retried or converted into a disconnected consent record",async()=>{
 const f=fixture();f.raw.mockRejectedValue(Error("Provider timeout"));await expect(f.run()).rejects.toThrow("Provider timeout");expect(f.raw).toHaveBeenCalledTimes(1);
});
test("context-probe budget is reserved before admitting the final independent probe",async()=>{
 const f=fixture(),raw=f.raw.getMockImplementation()!;f.raw.mockImplementation(async()=>{const v=await raw();jest.spyOn(Date,"now").mockReturnValue((stamp+15)*1000);return v;});
 await expect(f.run()).rejects.toThrow(/requires review/);expect(f.c.observeContext).toHaveBeenCalledTimes(1);
});
test("the maximum freshness boundary is explicit and deterministic",async()=>{
 const f=fixture();f.account.transaction_refresh!.last_attempted_at=stamp-TEAM_BANK_FEED_MAX_AGE_SECONDS;expect((await f.run()).health).toBe("ready");
});
