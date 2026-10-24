import {GET} from "@/app/api/sales-team/settlement/route";
import {teamAutomaticSettlementReady,teamTransferExecutionReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamAutomaticSettlement} from "@/lib/salesTeams/settlement";
jest.mock("@/lib/salesTeams/policy",()=>({teamAutomaticSettlementReady:jest.fn(),teamTransferExecutionReady:jest.fn()}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:jest.fn()}));
jest.mock("@/lib/salesTeams/settlement",()=>({runTeamAutomaticSettlement:jest.fn()}));
const secret="synthetic-settlement-cron-fixture-secret-only";
const req=(authorization:string|null=`Bearer ${secret}`)=>new Request("https://fixture.vercel.app/api/sales-team/settlement",{headers:authorization?{authorization}:{}});
beforeEach(()=>{jest.clearAllMocks();process.env.CRON_SECRET=secret;jest.mocked(teamAutomaticSettlementReady).mockReturnValue(true);jest.mocked(teamTransferExecutionReady).mockReturnValue(false);jest.mocked(runTeamAutomaticSettlement).mockResolvedValue({status:"complete",settled:1,held:0});});
test.each([null,"wrong",`Bearer ${secret}extra`])("invalid cron authorization precedes readiness and composition (%s)",async header=>{
 expect((await GET(req(header))).status).toBe(401);expect(teamAutomaticSettlementReady).not.toHaveBeenCalled();expect(createTeamPaymentContext).not.toHaveBeenCalled();expect(runTeamAutomaticSettlement).not.toHaveBeenCalled();
});
test("missing or weak secrets cannot authorize a worker",async()=>{
 delete process.env.CRON_SECRET;expect((await GET(req("Bearer undefined"))).status).toBe(401);process.env.CRON_SECRET="short";expect((await GET(req("Bearer short"))).status).toBe(401);expect(createTeamPaymentContext).not.toHaveBeenCalled();
});
test("default-off readiness stops before any client composition",async()=>{
 jest.mocked(teamAutomaticSettlementReady).mockReturnValue(false);expect((await GET(req())).status).toBe(409);expect(createTeamPaymentContext).not.toHaveBeenCalled();
});
test("authorized original observation remains available independently of fresh-money execution",async()=>{
 const response=await GET(req());expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(await response.json()).toEqual({status:"complete",settled:1,held:0});expect(runTeamAutomaticSettlement).toHaveBeenCalledWith(undefined,{admitNew:false});
});
test("fresh-money readiness is passed only after authentication and settlement readiness",async()=>{
 jest.mocked(teamTransferExecutionReady).mockReturnValue(true);await GET(req());expect(runTeamAutomaticSettlement).toHaveBeenCalledWith(undefined,{admitNew:true});
});
test("provider errors preserve holds without leaking details",async()=>{
 jest.mocked(runTeamAutomaticSettlement).mockRejectedValue(Error("private-provider-detail"));const log=jest.spyOn(console,"error").mockImplementation(()=>{});try{const response=await GET(req());expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toContain("private-provider-detail");}finally{log.mockRestore();}
});
