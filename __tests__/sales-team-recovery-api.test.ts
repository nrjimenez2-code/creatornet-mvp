import {GET} from "@/app/api/sales-team/recovery/route";
import {teamAutomaticRecoveryReady,teamFulfillmentReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
jest.mock("@/lib/salesTeams/policy",()=>({teamAutomaticRecoveryReady:jest.fn(),teamFulfillmentReady:jest.fn()}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:jest.fn()}));
jest.mock("@/lib/salesTeams/recovery",()=>({runTeamAutomaticRecovery:jest.fn()}));
const secret="synthetic-recovery-cron-fixture-secret-only";
const req=(authorization:string|null=`Bearer ${secret}`)=>new Request("https://fixture.vercel.app/api/sales-team/recovery",{headers:authorization?{authorization}:{}});
beforeEach(()=>{jest.clearAllMocks();process.env.CRON_SECRET=secret;jest.mocked(teamAutomaticRecoveryReady).mockReturnValue(true);jest.mocked(teamFulfillmentReady).mockReturnValue(false);jest.mocked(runTeamAutomaticRecovery).mockResolvedValue({status:"complete",observed:1,held:0});});
test.each([null,"wrong",`Bearer ${secret}extra`])("invalid cron authorization performs no composition or database work (%s)",async header=>{
 expect((await GET(req(header))).status).toBe(401);expect(createTeamPaymentContext).not.toHaveBeenCalled();expect(runTeamAutomaticRecovery).not.toHaveBeenCalled();
});
test("a missing secret cannot authorize the literal undefined bearer value",async()=>{
 delete process.env.CRON_SECRET;expect((await GET(req("Bearer undefined"))).status).toBe(401);expect(runTeamAutomaticRecovery).not.toHaveBeenCalled();
});
test("default-off source readiness stops before any provider/client composition",async()=>{
 jest.mocked(teamAutomaticRecoveryReady).mockReturnValue(false);expect((await GET(req())).status).toBe(409);expect(createTeamPaymentContext).not.toHaveBeenCalled();
});
test("authenticated ready invocation returns only bounded summary counts with no-store",async()=>{
 const response=await GET(req());expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(await response.json()).toEqual({status:"complete",observed:1,held:0});
});
test("unexpected internal errors preserve holds without exposing provider details",async()=>{
 jest.mocked(runTeamAutomaticRecovery).mockRejectedValue(Error("private-provider-detail"));const log=jest.spyOn(console,"error").mockImplementation(()=>{});
 try{const response=await GET(req());expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toContain("private-provider-detail");}finally{log.mockRestore();}
});
