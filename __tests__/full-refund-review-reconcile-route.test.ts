import {NextRequest} from "next/server";
const mockAdmin=jest.fn(),mockReady=jest.fn(),mockReconcile=jest.fn();
jest.mock("@/lib/admin/server",()=>({requireAdmin:()=>mockAdmin(),adminAuthErrorResponse:()=>new Response("unauthorized",{status:401})}));
jest.mock("@/lib/fullRefundReviewReconciliation",()=>({...jest.requireActual("@/lib/fullRefundReviewReconciliation"),fullRefundReviewReconciliationReady:()=>mockReady(),reconcileFullRefundReview:(...args:unknown[])=>mockReconcile(...args)}));
import {POST} from "../app/api/admin/full-refund-review/reconcile/route";
const origin="https://example.invalid",input={eventId:"evt_original",revision:3,confirmOriginalOnly:true};
const req=(body:unknown=input,from=origin,url=origin)=>new NextRequest(`${url}/api/admin/full-refund-review/reconcile`,{method:"POST",headers:{origin:from,"content-type":"application/json"},body:JSON.stringify(body)});
const prior=process.env.NEXT_PUBLIC_SITE_URL;
beforeEach(()=>{jest.clearAllMocks();process.env.NEXT_PUBLIC_SITE_URL=origin;mockAdmin.mockResolvedValue({admin:{},user:{id:"actor"}});mockReady.mockReturnValue(true);mockReconcile.mockResolvedValue({status:"original_reconciled_hold_retained",holdRetained:true,observation:"refund_review_recorded"});});
afterAll(()=>{if(prior===undefined)delete process.env.NEXT_PUBLIC_SITE_URL;else process.env.NEXT_PUBLIC_SITE_URL=prior;});
test("both origins must match before authentication",async()=>{expect((await POST(req(input,"https://foreign.invalid"))).status).toBe(403);expect((await POST(req(input,origin,"https://foreign.invalid"))).status).toBe(403);expect(mockAdmin).not.toHaveBeenCalled();});
test("unauthorized, disabled and unconfirmed requests cannot reconcile",async()=>{mockAdmin.mockRejectedValueOnce(Error());expect((await POST(req())).status).toBe(401);mockReady.mockReturnValueOnce(false);expect((await POST(req())).status).toBe(404);expect((await POST(req({...input,confirmOriginalOnly:false}))).status).toBe(400);expect(mockReconcile).not.toHaveBeenCalled();});
test("client cannot submit source/provider identity",async()=>{expect((await POST(req({...input,buyerId:"forged"}))).status).toBe(400);expect(mockReconcile).not.toHaveBeenCalled();});
test("success retains hold; uncertain/error result is 409 without raw exception or rollback claim",async()=>{
  const response=await POST(req());expect(await response.json()).toMatchObject({holdRetained:true,observation:"refund_review_recorded"});
  expect(mockReconcile).toHaveBeenCalledWith({},input);expect(response.headers.get("cache-control")).toBe("private, no-store");
  mockReconcile.mockResolvedValueOnce({status:"reconciliation_required",holdRetained:true});expect((await POST(req())).status).toBe(409);
  mockReconcile.mockRejectedValueOnce(Error("private"));const failure=await POST(req());expect(failure.status).toBe(409);expect(await failure.text()).not.toContain("private");
});
