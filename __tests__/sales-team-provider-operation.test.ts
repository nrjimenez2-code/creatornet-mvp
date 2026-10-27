import { runTeamProviderOperation,teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope,type TeamProviderRequest } from "@/lib/salesTeams/providerOperation";
const scope:TeamOperationScope={scopeId:"00000000-0000-4000-8000-000000000001",scopeKey:"intent:1",saleId:"00000000-0000-4000-8000-000000000001",creatorId:"00000000-0000-4000-8000-000000000002",actorId:"00000000-0000-4000-8000-000000000003",kind:"intent"};
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const request:TeamProviderRequest={method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:"/v1/payment_intents",params:{amount:10001,currency:"usd",confirm:false}};
const now=Date.parse("2026-10-21T20:00:00Z");
function fixture(workerRunId:string|null=null){
 const operationId=teamOperationId(scope);let state="dispatch";let bound:string|null=null;const object={id:"pi_original",requestId:"req_original"};
 const op=()=>({...scope,workerRunId,id:operationId,request,context,provider_id:bound,idempotency_key:`cn-team-v1:${operationId}`,lease_token:"00000000-0000-4000-8000-000000000004",
  lease_until:new Date(now+30000).toISOString(),first_dispatch_at:new Date(now).toISOString(),status:"dispatching"});
 const rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==="claim_sales_team_provider_operation_v1")return {data:{status:state,operation:op()},error:null};
  if(name==="assert_sales_team_provider_dispatch_v1")return {data:op(),error:null};
  if(name==="mark_sales_team_provider_unknown_v1"){state="reconciliation_required";return {data:null,error:null};}
  if(name==="bind_sales_team_provider_operation_v1"){bound=String(args.p_provider_id);state="bound";return {data:op(),error:null};}
  throw Error(name);
 });
 const create=jest.fn(async()=>object),retrieve=jest.fn(async()=>object),reconcileUnknown=jest.fn(async():Promise<typeof object|null>=>null),observeContext=jest.fn(async()=>context),assertSource=jest.fn(async()=>{}),validate=jest.fn();
 return {rpc,create,retrieve,reconcileUnknown,observeContext,assertSource,validate,setState:(s:string)=>{state=s;},run:()=>runTeamProviderOperation({admin:{rpc},scope,context,request,create,retrieve,reconcileUnknown,observeContext,assertSource,validate,now:()=>now})};
}
test("initial dispatch uses one immutable original key and independent readback",async()=>{
 const f=fixture();expect((await f.run()).status).toBe("bound");expect(f.create).toHaveBeenCalledTimes(1);expect(f.retrieve).toHaveBeenCalledWith("pi_original");
 expect(f.create.mock.calls[0]).toEqual([request,{idempotencyKey:`cn-team-v1:${teamOperationId(scope)}`,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}]);
 await f.run();expect(f.create).toHaveBeenCalledTimes(1);expect(f.retrieve).toHaveBeenCalledTimes(2);
});
test("a timed-out original is reconciled without repeating its POST",async()=>{
 const f=fixture();f.create.mockRejectedValueOnce(Error("timeout"));expect((await f.run()).status).toBe("reconciliation_required");
 expect((await f.run()).status).toBe("reconciliation_required");expect(f.create).toHaveBeenCalledTimes(1);expect(f.reconcileUnknown).toHaveBeenCalledWith(teamOperationId(scope));
 f.reconcileUnknown.mockResolvedValue({id:"pi_original",requestId:"req_read"});expect((await f.run()).status).toBe("bound");expect(f.create).toHaveBeenCalledTimes(1);
});
test.each(["busy","not_enabled"])("%s never dispatches a provider request",async status=>{
 const f=fixture();f.setState(status);expect((await f.run()).status).toBe(status);expect(f.create).not.toHaveBeenCalled();
});
test("context changes, source revocation and invalid provider proof stop dispatch/binding",async()=>{
 const f=fixture();f.observeContext.mockResolvedValueOnce({...context,platformAccountId:"acct_foreign"});await expect(f.run()).rejects.toThrow();expect(f.create).not.toHaveBeenCalled();
 const revoked=fixture();revoked.assertSource.mockRejectedValueOnce(Error("stopped"));await expect(revoked.run()).rejects.toThrow("stopped");expect(revoked.create).not.toHaveBeenCalled();
 const invalid=fixture();invalid.validate.mockImplementation(()=>{throw Error("wrong amount");});await expect(invalid.run()).rejects.toThrow("wrong amount");
 expect(invalid.rpc.mock.calls.some(([name])=>name==="bind_sales_team_provider_operation_v1")).toBe(false);
});
test("stable operation identity includes the sale, kind and period but no arbitrary retry salt",()=>{
 expect(teamOperationId(scope)).toBe(teamOperationId({...scope}));expect(teamOperationId({...scope,scopeKey:"intent:2"})).not.toBe(teamOperationId(scope));
 expect(teamOperationId({...scope,kind:"confirmation"})).not.toBe(teamOperationId(scope));
});
test("an original journal cannot be reopened under another worker identity",async()=>{
 const f=fixture("00000000-0000-4000-8000-000000000099");await expect(f.run()).rejects.toThrow();expect(f.create).not.toHaveBeenCalled();expect(f.retrieve).not.toHaveBeenCalled();
});
