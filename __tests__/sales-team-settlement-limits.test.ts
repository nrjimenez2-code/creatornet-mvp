import {runTeamAutomaticSettlement} from "@/lib/salesTeams/settlement";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {readTeamFinancialSnapshot} from "@/lib/salesTeams/financialReadback";
import {teamAutomaticSettlementReady,teamTransferExecutionReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
jest.mock("@/lib/salesTeams/transferExecution",()=>({dispatchTeamEarnedTransfer:jest.fn()}));
jest.mock("@/lib/salesTeams/financialReadback",()=>({readTeamFinancialSnapshot:jest.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(dispatchTeamEarnedTransfer).mockResolvedValue({status:"accounted",requestId:id(4),operationId:id(5),completed:true,held:false});});
function fixture(kind:"original"|"earned"="original",always=false){
 let selected=0;const raw=jest.fn(async()=>({lastResponse:{requestId:"req_fixture",headers:{},statusCode:200}}));
 const rpc=jest.fn(async(name:string)=>{
  const plan={id:id(3),kind,receipt_id:id(6),beneficiary:"creator",request_id:id(4),task_id:id(7),financial_check_id:id(8),transfer_check_id:id(9),recipient_source:null,source_ready:false};
  const data=name==="claim_sales_team_automatic_settlement_v1"?{status:"claimed",runId:id(1),leaseToken:id(2)}:name==="next_sales_team_settlement_plan_v1"?(selected++===0||always?plan:null):name==="run_sales_team_settlement_plan_v1"?{checkId:id(8),completed:false,held:true,source:{saleId:id(10),buyerId:id(11),obligationId:id(12),paymentIntentId:"pi_original",context}}:name==="finish_sales_team_settlement_plan_v1"?{held:kind==="earned",settled:kind==="original"}:null;
  return {data,error:null};
 });
 const c={context,observeContext:async()=>context,observeEvidence:jest.fn(),stripe:{rawRequest:raw},admin:{rpc}} as unknown as TeamReceiptComposition;
 return {c,raw,rpc};
}
test("the worker never selects or dispatches more than three durable tasks",async()=>{
 const f=fixture("original",true);expect(await runTeamAutomaticSettlement(f.c)).toMatchObject({settled:3,held:0});expect(f.rpc.mock.calls.filter(([name])=>name==="next_sales_team_settlement_plan_v1")).toHaveLength(3);expect(dispatchTeamEarnedTransfer).toHaveBeenCalledTimes(3);
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
