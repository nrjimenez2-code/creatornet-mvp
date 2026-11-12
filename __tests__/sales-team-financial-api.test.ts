import {NextRequest} from "next/server";
const auth=jest.fn(),inspect=jest.fn(),review=jest.fn(),compose=jest.fn(),ready=jest.fn();
jest.mock("@/lib/admin/server",()=>({requireAdmin:(...args:unknown[])=>auth(...args),adminAuthErrorResponse:()=>new Response("{}",{status:403})}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/salesTeams/policy",()=>({teamFinancialReconciliationReady:()=>ready(),teamRefundReviewReady:()=>ready()}));
jest.mock("@/lib/salesTeams/financialChecks",()=>({inspectTeamReceiptFinancials:(...args:unknown[])=>inspect(...args),reviewTeamRefundResponsibility:(...args:unknown[])=>review(...args)}));
import {POST} from "@/app/api/admin/sales-team/financial/route";
const receiptId="00000000-0000-4000-8000-000000000001",requestId="00000000-0000-4000-8000-000000000002",actorId="00000000-0000-4000-8000-000000000003";
const body={action:"inspect",receiptId,requestId};
const request=(value:unknown=body,origin="https://fixture.invalid")=>new NextRequest("https://fixture.invalid/api/admin/sales-team/financial",{method:"POST",headers:{host:"fixture.invalid",origin,"Content-Type":"application/json"},body:JSON.stringify(value)});
beforeEach(()=>{jest.clearAllMocks();auth.mockResolvedValue({user:{id:actorId},admin:{}});ready.mockReturnValue(true);compose.mockReturnValue({original:true});inspect.mockResolvedValue({receiptId,held:true});review.mockResolvedValue({reviewId:requestId,holdRetained:true});});
test("cross-origin inspection is rejected before authentication",async()=>{expect((await POST(request(body,"https://elsewhere.invalid"))).status).toBe(403);expect(auth).not.toHaveBeenCalled();});
test("persisted admin authorization is required before composing financial context",async()=>{auth.mockRejectedValueOnce(Error("denied"));expect((await POST(request())).status).toBe(403);expect(compose).not.toHaveBeenCalled();});
test("disabled financial readiness retains the hold without dispatch",async()=>{ready.mockReturnValue(false);expect((await POST(request())).status).toBe(409);expect(compose).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();});
test("inspection binds actor and original UUID and never accepts a caller actor",async()=>{
 const response=await POST(request());expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(inspect).toHaveBeenCalledWith({original:true},receiptId,actorId,requestId);
 expect((await POST(request({...body,actorId:"forged"}))).status).toBe(400);
});
test("responsibility review forwards only explicit approved fields",async()=>{
 expect((await POST(request({...body,action:"review_refund",refundId:"re_original",expectedRevision:3,responsibility:"creator",reasonCode:"creator_discretionary"}))).status).toBe(200);
 expect(review).toHaveBeenCalledWith({original:true},{actorId,receiptId,requestId,expectedRevision:3,refundId:"re_original",responsibility:"creator",reasonCode:"creator_discretionary"});expect(inspect).not.toHaveBeenCalled();
});
test.each([{receiptId:"bad"},{requestId:null},{action:"refund"},{action:"review_refund",expectedRevision:1.5}])("invalid request fails closed: %o",async(extra)=>{expect((await POST(request({...body,...extra}))).status).toBe(400);expect(inspect).not.toHaveBeenCalled();expect(review).not.toHaveBeenCalled();});
test("unknown inspection result reports a retained hold without leaking provider detail",async()=>{inspect.mockRejectedValueOnce(Error("private provider data"));const response=await POST(request());expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toContain("private provider");});
