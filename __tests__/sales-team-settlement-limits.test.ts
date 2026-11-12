import {runTeamAutomaticSettlement} from "@/lib/salesTeams/settlement";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {readTeamFinancialSnapshot} from "@/lib/salesTeams/financialReadback";
import {dispatchTeamTransferRecovery} from "@/lib/salesTeams/transferRecoveryExecution";
import {recoverTeamOriginalTransferReversal} from "@/lib/salesTeams/transferReversalRecovery";
import {teamAutomaticSettlementReady,teamTransferExecutionReady,teamAutomaticTransferRecoveryReady,teamTransferRecoveryExecutionReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
jest.mock("@/lib/salesTeams/transferExecution",()=>({dispatchTeamEarnedTransfer:jest.fn()}));
jest.mock("@/lib/salesTeams/financialReadback",()=>({readTeamFinancialSnapshot:jest.fn()}));
jest.mock("@/lib/salesTeams/transferRecoveryExecution",()=>({dispatchTeamTransferRecovery:jest.fn()}));
jest.mock("@/lib/salesTeams/transferReversalRecovery",()=>({recoverTeamOriginalTransferReversal:jest.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.resetAllMocks();jest.mocked(dispatchTeamEarnedTransfer).mockResolvedValue({status:"accounted",requestId:id(4),operationId:id(5),completed:true,held:false});jest.mocked(dispatchTeamTransferRecovery).mockResolvedValue({status:"accounted",requestId:id(4),operationId:id(5),completed:true,held:false});jest.mocked(recoverTeamOriginalTransferReversal).mockResolvedValue({completed:true,recorded:false,held:false});});
function fixture(kind:"original"|"earned"|"recovery"="original",always=false,bound=true){
 let selected=0,anyHeld=false;const raw=jest.fn(async()=>({lastResponse:{requestId:"req_fixture",headers:{},statusCode:200}}));
 const rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  const plan={id:id(3),kind,receipt_id:id(6),beneficiary:"creator",request_id:id(4),task_id:id(7),financial_check_id:id(8),transfer_check_id:id(9),recipient_source:null,source_ready:false,recovery:{transferRequestId:id(13),operationId:bound?id(5):null,reserved:{id:id(4)}}};
  let data:unknown=null;
  if(["claim_sales_team_automatic_settlement_v1","claim_sales_team_combined_settlement_v1"].includes(name))data={status:"claimed",runId:id(1),leaseToken:id(2)};
  else if(["next_sales_team_settlement_plan_v1","next_sales_team_combined_settlement_plan_v1"].includes(name))data=selected++===0||always?plan:null;
  else if(name==="run_sales_team_settlement_plan_v1")data={checkId:id(8),completed:false,held:true,source:{saleId:id(10),buyerId:id(11),obligationId:id(12),paymentIntentId:"pi_original",context}};
  else if(name==="finish_sales_team_settlement_plan_v1"){anyHeld||=args.p_held!==false;data={held:args.p_held!==false,settled:args.p_held===false};}
  else if(name==="finish_sales_team_combined_settlement_v1")data={status:anyHeld?"review_required":"complete"};
  return {data,error:null};
 });
 const c={context,observeContext:async()=>context,observeEvidence:jest.fn(),stripe:{rawRequest:raw},admin:{rpc}} as unknown as TeamReceiptComposition;
 return {c,raw,rpc};
}
test("the worker never selects or dispatches more than three durable tasks",async()=>{
 const f=fixture("original",true);expect(await runTeamAutomaticSettlement(f.c)).toMatchObject({settled:3,held:0});expect(f.rpc.mock.calls.filter(([name])=>name==="next_sales_team_settlement_plan_v1")).toHaveLength(3);expect(dispatchTeamEarnedTransfer).toHaveBeenCalledTimes(3);
});

test("combined recovery uses the same three-plan cap",async()=>{
 const f=fixture("recovery",true);expect(await runTeamAutomaticSettlement(f.c,{recoverTransfers:true})).toMatchObject({status:"complete",settled:3});expect(f.rpc.mock.calls.filter(([name])=>name==="next_sales_team_combined_settlement_plan_v1")).toHaveLength(3);expect(recoverTeamOriginalTransferReversal).toHaveBeenCalledTimes(3);expect(dispatchTeamEarnedTransfer).not.toHaveBeenCalled();
});
test("combined recovery cannot exceed the shared forty-GET transport budget",async()=>{
 const f=fixture("recovery");jest.mocked(recoverTeamOriginalTransferReversal).mockImplementation(async reader=>{for(let n=0;n<41;n++)await reader.stripe.rawRequest("GET","/v1/events",{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticSettlement(f.c,{recoverTransfers:true})).toMatchObject({status:"review_required",held:1});expect(f.raw).toHaveBeenCalledTimes(40);
});
test("combined recovery cannot issue more than three POSTs",async()=>{
 const f=fixture("recovery",false,false);jest.mocked(dispatchTeamTransferRecovery).mockImplementation(async reader=>{for(let n=0;n<4;n++)await reader.stripe.rawRequest("POST","/v1/transfers/tr_original/reversals",{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticSettlement(f.c,{recoverTransfers:true,admitRecovery:true})).toMatchObject({status:"review_required",held:1});expect(f.raw).toHaveBeenCalledTimes(3);
});
test.each(["/v1/refunds","/v1/transfers"])("a recovery plan cannot use the %s POST path",async path=>{
 const f=fixture("recovery",false,false);jest.mocked(dispatchTeamTransferRecovery).mockImplementation(async reader=>{await reader.stripe.rawRequest("POST",path,{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticSettlement(f.c,{recoverTransfers:true,admitRecovery:true,admitNew:true})).toMatchObject({held:1});expect(f.raw).not.toHaveBeenCalled();
});
test("combined recovery retains its observation-only dispatch argument",async()=>{
 const f=fixture("recovery",false,false);jest.mocked(dispatchTeamTransferRecovery).mockResolvedValue({status:"not_dispatched",requestId:id(4),operationId:id(5),completed:false,held:true});await runTeamAutomaticSettlement(f.c,{recoverTransfers:true});expect(dispatchTeamTransferRecovery).toHaveBeenCalledWith(expect.anything(),expect.anything(),false);expect(f.raw).not.toHaveBeenCalled();
});
test("combined recovery preserves a supplied shorter GET timeout",async()=>{
 const f=fixture("recovery");jest.mocked(recoverTeamOriginalTransferReversal).mockImplementation(async reader=>{await reader.stripe.rawRequest("GET","/v1/events",{},{timeout:1200});return {completed:true,recorded:false,held:false};});
 await runTeamAutomaticSettlement(f.c,{recoverTransfers:true});expect(f.raw.mock.calls[0]).toBeDefined();expect((f.raw.mock.calls as unknown[][])[0][3]).toMatchObject({timeout:1200,maxNetworkRetries:0});
});
test.each([45000,65000])("combined recovery starts no new request past its %i-ms boundary",async elapsed=>{
 const f=fixture("recovery",false,false);let clock=0;f.raw.mockImplementation(async()=>{clock=elapsed;return {lastResponse:{requestId:"req_clock",headers:{},statusCode:200}};});
 jest.mocked(dispatchTeamTransferRecovery).mockImplementation(async reader=>{await reader.stripe.rawRequest("GET","/v1/transfers/tr_original",{},{});await reader.stripe.rawRequest(elapsed===45000?"POST":"GET",elapsed===45000?"/v1/transfers/tr_original/reversals":"/v1/events",{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticSettlement(f.c,{recoverTransfers:true,admitRecovery:true,now:()=>clock})).toMatchObject({held:1});expect(f.raw).toHaveBeenCalledTimes(1);
});
test("combined recovery drains admitted GETs before recording plan and run outcomes",async()=>{
 const f=fixture("recovery");let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
 f.raw.mockImplementationOnce(async()=>{entered();await held;return {lastResponse:{requestId:"req_deferred",headers:{},statusCode:200}};}).mockRejectedValueOnce(Error("synthetic parallel recovery read failure"));
 jest.mocked(recoverTeamOriginalTransferReversal).mockImplementation(async reader=>{await Promise.all([reader.stripe.rawRequest("GET","/v1/events",{},{}),reader.stripe.rawRequest("GET","/v1/transfers/tr_original",{},{})]);throw Error("unreachable");});
 const run=runTeamAutomaticSettlement(f.c,{recoverTransfers:true});await started;await Promise.resolve();expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_settlement_plan_v1")).toBe(false);release();expect(await run).toMatchObject({held:1});expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_combined_settlement_v1")).toBe(true);
});
test("combined source readiness keeps new-money readiness separate",()=>{
 const env=Object.fromEntries(["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY","CREATOR_TEAM_CASH_SCHEMA_READY","CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY","CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY","CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY","CREATOR_TEAM_AUTOMATIC_SETTLEMENT_SCHEMA_READY","CREATOR_TEAM_AUTOMATIC_SETTLEMENT_READY","CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_SCHEMA_READY","CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_READY","CREATOR_TEAM_TRANSFER_RECOVERY_RESERVATIONS_SCHEMA_READY","CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_SCHEMA_READY","CREATOR_TEAM_TRANSFER_REVERSAL_RECOVERY_SCHEMA_READY","CREATOR_TEAM_TRANSFER_REVERSAL_RECOVERY_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_READY"].map(key=>[key,"true"]));
 expect(teamAutomaticTransferRecoveryReady({})).toBe(false);expect(teamAutomaticTransferRecoveryReady(env)).toBe(true);expect(teamTransferExecutionReady(env)).toBe(false);expect(teamTransferRecoveryExecutionReady(env)).toBe(false);for(const key of ["CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_READY"])expect(teamAutomaticTransferRecoveryReady({...env,[key]:"false"})).toBe(false);
});
test("the shared object-read budget caps actual transport calls at forty",async()=>{
 const f=fixture("earned");jest.mocked(readTeamFinancialSnapshot).mockImplementation(async reader=>{for(let n=0;n<41;n++)await reader.stripe.rawRequest("GET","/v1/refunds",{},{});throw Error("unreachable");});
 expect(await runTeamAutomaticSettlement(f.c,{admitNew:true})).toMatchObject({status:"review_required",held:1});expect(f.raw).toHaveBeenCalledTimes(40);expect(dispatchTeamEarnedTransfer).not.toHaveBeenCalled();
});
test("admitted parallel GETs drain before task outcome or run audit is recorded",async()=>{
 const f=fixture("earned");let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
 f.raw.mockImplementationOnce(async()=>{entered();await held;return {lastResponse:{requestId:"req_deferred",headers:{},statusCode:200}};}).mockRejectedValueOnce(Error("synthetic parallel GET failure"));
 jest.mocked(readTeamFinancialSnapshot).mockImplementation(async reader=>{await Promise.all([reader.stripe.rawRequest("GET","/v1/disputes",{},{}),reader.stripe.rawRequest("GET","/v1/refunds",{},{})]);throw Error("unreachable");});
 const run=runTeamAutomaticSettlement(f.c,{admitNew:true});await started;await Promise.resolve();expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_settlement_plan_v1")).toBe(false);release();expect(await run).toMatchObject({held:1});expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_automatic_settlement_v1")).toBe(true);
});
test("settlement source readiness is default off and independent of new transfer execution",()=>{
 const base={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY:"true"};
 expect(teamAutomaticSettlementReady(base)).toBe(false);const ready={...base,CREATOR_TEAM_AUTOMATIC_SETTLEMENT_SCHEMA_READY:"true",CREATOR_TEAM_AUTOMATIC_SETTLEMENT_READY:"true"};expect(teamAutomaticSettlementReady(ready)).toBe(true);expect(teamTransferExecutionReady(ready)).toBe(false);
});
