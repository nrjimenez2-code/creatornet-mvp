import {runTeamAutomaticCollection} from "@/lib/salesTeams/automaticCollection";
import {advanceTeamAutomaticCollection} from "@/lib/salesTeams/savedCollection";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

jest.mock("@/lib/salesTeams/savedCollection",()=>({advanceTeamAutomaticCollection:jest.fn()}));
jest.mock("@/lib/salesTeams/receipts",()=>({recordTeamCapture:jest.fn()}));
jest.mock("@/lib/salesTeams/collection",()=>({readTeamCollection:jest.fn(),teamCollectionView:jest.fn()}));
jest.mock("@/lib/salesTeams/savedMethod",()=>({recordTeamSavedMethod:jest.fn()}));

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.resetAllMocks();jest.mocked(advanceTeamAutomaticCollection).mockRejectedValue(Error("synthetic held original"));});

function fixture(always=false){
 let selected=0,anyHeld=false;
 const raw=jest.fn(async(...request:unknown[])=>{void request;return {lastResponse:{requestId:"req_fixture",headers:{},statusCode:200}};});
 const rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  let data:unknown=null;
  if(name==="claim_sales_team_collection_run_v1")data={status:"claimed",runId:id(1),leaseToken:id(2)};
  if(name==="next_sales_team_collection_task_v1")data=selected++===0||always?{id:id(3+selected),run_id:id(1),obligation_id:id(10+selected),kind:"original"}:null;
  if(name==="finish_sales_team_collection_task_v1"){anyHeld||=args.p_held!==false;data={held:args.p_held!==false};}
  if(name==="finish_sales_team_collection_run_v1")data={status:anyHeld||args.p_failed?"review_required":"complete"};
  return {data,error:null};
 });
 const from=jest.fn(()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{sale_id:id(20),buyer_id:id(21)},error:null})})})}));
 const observeContext=jest.fn(async()=>context);
 const c={context,observeContext,observeEvidence:jest.fn(),stripe:{rawRequest:raw},admin:{rpc,from}} as unknown as TeamReceiptComposition;
 return {c,raw,rpc,from,observeContext};
}

test("collection stops after three durable tasks even if selection keeps returning work",async()=>{
 const f=fixture(true);expect(await runTeamAutomaticCollection(f.c)).toMatchObject({held:3});
 expect(f.rpc.mock.calls.filter(([name])=>name==="next_sales_team_collection_task_v1")).toHaveLength(3);
 expect(advanceTeamAutomaticCollection).toHaveBeenCalledTimes(3);
});

test("all collection tasks share a forty-object-GET transport budget",async()=>{
 const f=fixture(true);jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{
  for(let n=0;n<21;n++)await reader.stripe.rawRequest("GET","/v1/events",{},{});
  throw Error("synthetic held original");
 });
 expect(await runTeamAutomaticCollection(f.c)).toMatchObject({held:3});expect(f.raw).toHaveBeenCalledTimes(40);
});

test("collection permits at most three actual POSTs within one run",async()=>{
 const f=fixture();jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{
  for(let n=0;n<4;n++)await reader.stripe.rawRequest("POST","/v1/payment_intents/pi_original/confirm",{},{});
  throw Error("unreachable");
 });
 expect(await runTeamAutomaticCollection(f.c,{admitNew:true})).toMatchObject({held:1});expect(f.raw).toHaveBeenCalledTimes(3);
 for(const call of f.raw.mock.calls)expect(call[3]).toMatchObject({apiVersion:"2026-08-26.dahlia",maxNetworkRetries:0,timeout:10000});
});

test.each(["/v1/refunds","/v1/transfers","/v1/payment_intents/pi_original/cancel"])("collection cannot POST to %s",async path=>{
 const f=fixture();jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{await reader.stripe.rawRequest("POST",path,{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticCollection(f.c,{admitNew:true})).toMatchObject({held:1});expect(f.raw).not.toHaveBeenCalled();
});

test("an observation-only collection run cannot POST",async()=>{
 const f=fixture();jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async(reader,worker,_sale,_buyer,admitNew)=>{
  expect(admitNew).toBe(false);expect(worker.canDispatch?.()).toBe(false);
  await reader.stripe.rawRequest("POST","/v1/payment_intents",{},{});throw Error("unreachable");
 });
 expect(await runTeamAutomaticCollection(f.c)).toMatchObject({held:1});expect(f.raw).not.toHaveBeenCalled();
});

test("the fresh-phase cutoff closes dispatch during a task",async()=>{
 const f=fixture();let clock=0,observed=false;
 jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async(_reader,worker)=>{expect(worker.canDispatch?.()).toBe(true);clock=25000;expect(worker.canDispatch?.()).toBe(false);observed=true;throw Error("held at cutoff");});
 await runTeamAutomaticCollection(f.c,{admitNew:true,now:()=>clock});expect(observed).toBe(true);expect(f.raw).not.toHaveBeenCalled();
});

test.each([45000,65000,-1])("collection starts no new transport at its %i-ms boundary",async elapsed=>{
 const f=fixture();let clock=0;
 f.raw.mockImplementation(async()=>{clock=elapsed;return {lastResponse:{requestId:"req_clock",headers:{},statusCode:200}};});
 jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{
  await reader.stripe.rawRequest("GET","/v1/payment_intents/pi_original",{},{});
  await reader.stripe.rawRequest(elapsed===45000?"POST":"GET",elapsed===45000?"/v1/payment_intents/pi_original/confirm":"/v1/events",{},{});
  throw Error("unreachable");
 });
 expect(await runTeamAutomaticCollection(f.c,{admitNew:true,now:()=>clock})).toMatchObject({held:1});expect(f.raw).toHaveBeenCalledTimes(1);
});

test("the object-read timeout shrinks to the remaining observation window",async()=>{
 const f=fixture();let clock=0;
 jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{clock=64900;await reader.stripe.rawRequest("GET","/v1/events",{},{});throw Error("synthetic held original");});
 await runTeamAutomaticCollection(f.c,{now:()=>clock});expect(f.raw.mock.calls[0][3]).toMatchObject({timeout:100,maxNetworkRetries:0});
});

test("admitted concurrent reads drain before task and run outcomes",async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
 f.raw.mockImplementationOnce(async()=>{entered();await pending;return {lastResponse:{requestId:"req_deferred",headers:{},statusCode:200}};}).mockRejectedValueOnce(Error("synthetic concurrent read failure"));
 jest.mocked(advanceTeamAutomaticCollection).mockImplementation(async reader=>{await Promise.all([reader.stripe.rawRequest("GET","/v1/events",{},{}),reader.stripe.rawRequest("GET","/v1/payment_intents/pi_original",{},{})]);throw Error("unreachable");});
 const run=runTeamAutomaticCollection(f.c);await started;await Promise.resolve();
 expect(f.rpc.mock.calls.some(([name])=>name.startsWith("finish_"))).toBe(false);
 release();expect(await run).toMatchObject({held:1});expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_collection_run_v1")).toBe(true);
});

test("context drift before claim consumes no slot",async()=>{
 const f=fixture();f.observeContext.mockResolvedValue({...context,platformAccountId:"acct_foreign"});
 await expect(runTeamAutomaticCollection(f.c)).rejects.toThrow(/context changed/);expect(f.rpc).not.toHaveBeenCalled();expect(f.raw).not.toHaveBeenCalled();
});

test("a selection failure still records the failed run without dispatch",async()=>{
 const f=fixture();const original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation(async(name,args)=>{if(name==="next_sales_team_collection_task_v1")throw Error("synthetic selection failure");return original(name,args);});
 await expect(runTeamAutomaticCollection(f.c)).rejects.toThrow(/selection failure/);
 expect(f.rpc).toHaveBeenLastCalledWith("finish_sales_team_collection_run_v1",expect.objectContaining({p_failed:true}),undefined);expect(f.raw).not.toHaveBeenCalled();
});
