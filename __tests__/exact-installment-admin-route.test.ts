import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/admin/installments/route";
import { requireAdmin } from "../lib/admin/server";
import { stopExactInstallmentBillingSandbox } from "../lib/installments/billingStop";
import { readExactAdminPage } from "../lib/installments/adminActions";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
jest.mock("../lib/admin/server",()=>({requireAdmin:jest.fn(),adminAuthErrorResponse:()=>new Response(null,{status:403})}));
jest.mock("../lib/installments/adminActions",()=>({...jest.requireActual("../lib/installments/adminActions"),readExactAdminPage:jest.fn()}));
jest.mock("../lib/installments/billingStop",()=>({createExactBillingStopStore:jest.fn(()=>({})),stopExactInstallmentBillingSandbox:jest.fn()}));
jest.mock("../lib/installments/agreementStore",()=>({...jest.requireActual("../lib/installments/agreementStore"),createExactAgreementStore:jest.fn(()=>({}))}));
jest.mock("../lib/stripeClient",()=>({getStripe:()=>({})}));
const f=exactInstallmentFixture(); const auth=jest.mocked(requireAdmin),stop=jest.mocked(stopExactInstallmentBillingSandbox);
const list=jest.mocked(readExactAdminPage);const originalEnv=process.env;
const body={agreementId:f.agreement.id,requestId:f.terms.buyerId,confirmation:"STOP_FUTURE_BILLING"};
const req=(data:unknown=body,origin:string|null=f.env.NEXT_PUBLIC_SITE_URL!)=>new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/admin/installments`,{
  method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body:JSON.stringify(data)});
beforeEach(()=>{
  jest.clearAllMocks();process.env={...originalEnv,...f.env,CREATOR_EXACT_INSTALLMENTS_ADMIN_READY:"true",CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true"};
  auth.mockResolvedValue({user:{id:f.terms.creatorId},admin:{}} as never);list.mockResolvedValue({plans:[],nextCursor:null});
});
afterEach(()=>{process.env=originalEnv;});
test.each([null,"https://evil.test"])("rejects %s Origin without an auth/stop call",async(origin)=>{
  expect((await POST(req(body,origin))).status).toBe(403);expect(auth).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
});
test("only a verified administrator can read or act",async()=>{
  auth.mockRejectedValue(new Error("SECRET"));expect((await POST(req())).status).toBe(403);
  expect((await GET(new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/admin/installments`))).status).toBe(403);
  expect(list).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
});
test("a production or disabled route does not invoke the workflow",async()=>{
  process.env.VERCEL_ENV="production";expect((await POST(req())).status).toBe(404);expect(stop).not.toHaveBeenCalled();
});
test("a forged actor or missing confirmation never starts a stop",async()=>{
  expect((await POST(req({...body,actorId:f.terms.buyerId}))).status).toBe(400);
  expect((await POST(req({...body,confirmation:false}))).status).toBe(400);expect(stop).not.toHaveBeenCalled();
});
test.each(["collection_stopped","busy","reconciliation_required"] as const)("%s is accurately reported with no-store",async(status)=>{
  stop.mockResolvedValue({status});const r=await POST(req());expect(r.status).toBe(status==="collection_stopped"?200:202);
  expect(r.headers.get("cache-control")).toContain("no-store");expect(await r.json()).toEqual({status});
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({actorId:f.terms.creatorId,agreementId:body.agreementId,requestId:body.requestId}));
});
test("lost stop response neither leaks provider errors nor claims no action occurred",async()=>{
  stop.mockRejectedValue(new Error("SECRET https://stripe/private"));const r=await POST(req());expect(r.status).toBe(409);
  const text=await r.text();expect(text).not.toMatch(/SECRET|stripe\/private|No action was taken/);expect(text).toContain("same request");
});
test("GET is read-only and rejects a malformed cursor",async()=>{
  const r=await GET(new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/admin/installments`));expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toContain("no-store");expect(stop).not.toHaveBeenCalled();
  expect((await GET(new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/admin/installments?after=bad`))).status).toBe(400);
});
