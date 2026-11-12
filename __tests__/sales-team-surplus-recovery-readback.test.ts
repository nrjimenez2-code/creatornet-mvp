import type Stripe from "stripe";
import {teamSurplusPayoutFixture} from "../test-support/sales-team-surplus-payout-fixture";
import {inspectTeamSurplusCreationEvent,readTeamUnknownSurplus} from "@/lib/salesTeams/surplusRecoveryReadback";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

function fixture(){
 const f=teamSurplusPayoutFixture();f.q.operation={...f.q.operation,status:"unknown",provider_id:null,provider_request_id:null};
 const event={id:"evt_original",object:"event",type:"payout.created",api_version:TEAM_STRIPE_API_VERSION,account:null,context:null,created:f.payout.created,livemode:false,
  request:{id:"req_originalCreate",idempotency_key:f.q.operation.idempotency_key},data:{object:{...f.payout,lastResponse:undefined}}} as unknown as Stripe.Event;
 const pages=[{object:"list",url:"/v1/events",has_more:false,data:[event]}];let page=0,seq=0;
 const raw=jest.fn(async(method:string,path:string,params:unknown,options:unknown):Promise<Record<string,unknown>>=>{void params;void options;if(method!=="GET")throw Error("GET only");
  const value=path==="/v1/events"?pages[page++]:path==="/v1/events/evt_original"?event:path==="/v1/payouts/po_original"?f.payout:path==="/v1/balance_transactions/txn_debit"?f.debit:path==="/v1/balance_transactions/txn_return"?f.returned:null;
  if(!value)throw Error(path);return {...value,lastResponse:{requestId:`req_recovery${++seq}`}};
 });
 const c={context:f.q.context,observeContext:async()=>f.q.context,stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 return {...f,event,pages,raw,c,read:()=>readTeamUnknownSurplus(c,f.q)};
}
test("complete discovery retrieves the exact creation event on both sides of independent money reads",async()=>{
 const h=fixture(),proof=await h.read();expect(proof).toMatchObject({event:{eventId:"evt_original",originalRequestId:"req_originalCreate",idempotencyKey:h.q.operation.idempotency_key},money:{complete:true,bankConfirmed:false}});
 expect(h.raw.mock.calls.map(([,path])=>path)).toEqual(["/v1/events","/v1/events/evt_original","/v1/payouts/po_original","/v1/balance_transactions/txn_debit","/v1/payouts/po_original","/v1/events/evt_original"]);
 for(const [method,, ,options] of h.raw.mock.calls){expect(method).toBe("GET");expect(options).toMatchObject({apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0});}
 expect(h.raw.mock.calls[0][2]).toMatchObject({type:"payout.created",limit:100,created:{gte:Math.floor(Date.parse(h.q.operation.first_dispatch_at)/1000)-5}});
});
test("creation snapshot identity permits a later failed payout and independently verified return",async()=>{
 const h=fixture();h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";expect((await h.read())?.money).toMatchObject({complete:true,disposition:"returned",bankConfirmed:false});
});
test.each(["empty","ambiguous","incomplete","expired"])("%s discovery cannot invent unsent evidence or adopt a payout",async fault=>{
 const h=fixture();if(fault==="empty")h.pages[0].data=[];
 if(fault==="ambiguous")h.pages[0].data.push({...h.event,id:"evt_other"});
 if(fault==="incomplete")h.pages.splice(0,1,...[1,2,3].map(n=>({object:"list",url:"/v1/events",has_more:true,data:[{...h.event,id:`evt_page${n}`}]})));
 if(fault==="expired"){h.q.operation.first_dispatch_at=new Date(Date.now()-31*86400000).toISOString();h.q.created_at=h.q.operation.first_dispatch_at;}
 expect(await h.read()).toBeNull();expect(h.raw.mock.calls.every(([,path])=>path==="/v1/events")).toBe(true);expect(h.raw.mock.calls.length).toBeLessThanOrEqual(3);
});
test("a complete multi-page search retains the fixed interval and exact continuation cursor",async()=>{
 const h=fixture();h.pages.unshift({object:"list",url:"/v1/events",has_more:true,data:[{...h.event,id:"evt_unrelated",request:{id:"req_unrelated",idempotency_key:"different"}}]});
 expect(await h.read()).not.toBeNull();expect(h.raw.mock.calls[1][2]).toEqual({...h.raw.mock.calls[0][2] as object,starting_after:"evt_unrelated"});
});
test.each(["key","original_request","mode","connected","context","version","amount","bank","metadata","time"])("the independently retrieved %s identity cannot be substituted",async fault=>{
 const h=fixture(),candidate=JSON.parse(JSON.stringify(h.event)) as Stripe.Event;
 if(fault==="key")candidate.request!.idempotency_key="other";if(fault==="original_request")candidate.request!.id=null;
 if(fault==="mode")candidate.livemode=true;if(fault==="connected")candidate.account="acct_other";if(fault==="context")candidate.context="acct_other";
 if(fault==="version")candidate.api_version="2020-08-27";
 const p=candidate.data.object as Stripe.Payout;if(fault==="amount")p.amount++;if(fault==="bank")p.destination="ba_other";
 if(fault==="metadata")p.metadata={};if(fault==="time")candidate.created-=86400;
 expect(()=>inspectTeamSurplusCreationEvent(h.q,candidate,h.now-15,h.now)).toThrow(/requires review/);
});
test("a list candidate alone cannot bind when its exact event cannot be retrieved",async()=>{
 const h=fixture(),base=h.raw.getMockImplementation()!;h.raw.mockImplementation(async(...args)=>{if(args[1].startsWith("/v1/events/"))throw Error("event unavailable");return base(...args);});
 await expect(h.read()).rejects.toThrow("event unavailable");expect(h.raw.mock.calls.some(([,p])=>p.startsWith("/v1/payouts/"))).toBe(false);
});
test.each(["event","duplicate_request","original_request_reuse","context","duplicate_event","budget"])("%s drift during readback is held",async fault=>{
 const h=fixture(),base=h.raw.getMockImplementation()!;let count=0;
 h.raw.mockImplementation(async(...args)=>{const result=await base(...args);count++;
  if(fault==="event"&&args[1]==="/v1/events/evt_original"&&count>2)return {...result,request:{...h.event.request,id:"req_differentOriginal"}};
  if(fault==="duplicate_request")return {...result,lastResponse:{requestId:"req_same"}};
  if(fault==="original_request_reuse")return {...result,lastResponse:{requestId:"req_originalCreate"}};
  if(fault==="context"&&count===1)h.c.observeContext=async()=>({...h.q.context,platformAccountId:"acct_changed"});
  return result;
 });
 if(fault==="duplicate_event")h.pages[0].data.push(h.event);
 let ms=Date.now();await expect(fault==="budget"?readTeamUnknownSurplus(h.c,h.q,{now:()=>{ms+=10000;return ms;}}):h.read()).rejects.toThrow(/requires review/);
});
