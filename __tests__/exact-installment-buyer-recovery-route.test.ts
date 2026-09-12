import { NextRequest } from "next/server";
import { GET,POST } from "../app/api/installments/recovery/route";
import { getAuthenticatedUser } from "../lib/supabaseConnectAuth";
import { buyerRecoveryController } from "../lib/installments/buyerRecoveryServer";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
jest.mock("../lib/supabaseConnectAuth",()=>({getAuthenticatedUser:jest.fn()}));
jest.mock("../lib/installments/buyerRecoveryServer",()=>({buyerRecoveryController:jest.fn()}));
const auth=jest.mocked(getAuthenticatedUser),controller=jest.mocked(buyerRecoveryController),read=jest.fn(),act=jest.fn();
const f=exactInstallmentFixture(),originalEnv=process.env;
const body={agreementId:f.agreement.id,action:"confirm_payment",quoteId:f.terms.buyerId,accepted:true,consentVersion:"single-invoice-retry-v1"};
const req=(value:unknown=body,origin:string|null=f.env.NEXT_PUBLIC_SITE_URL!)=>new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/installments/recovery`,{
  method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body:JSON.stringify(value)});
const get=()=>GET(new NextRequest(`${f.env.NEXT_PUBLIC_SITE_URL}/api/installments/recovery?agreementId=${f.agreement.id}`));
beforeEach(()=>{
  jest.clearAllMocks();process.env={...originalEnv,...f.env,CREATOR_EXACT_INSTALLMENTS_BUYER_RECOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true"};
  auth.mockResolvedValue({id:f.terms.buyerId} as never);controller.mockReturnValue({read,act});read.mockResolvedValue({title:"Synthetic"});
  act.mockResolvedValue({status:"payment_confirmation_recorded"});
});
afterEach(()=>{process.env=originalEnv;});
test.each([null,"https://evil.test"])("%s Origin cannot start a buyer action",async(origin)=>{
  expect((await POST(req(body,origin))).status).toBe(403);expect(auth).not.toHaveBeenCalled();expect(controller).not.toHaveBeenCalled();
});
test("production/disabled controls never construct private data or Stripe clients",async()=>{
  process.env.VERCEL_ENV="production";
  expect((await get()).status).toBe(404);expect((await POST(req())).status).toBe(404);expect(controller).not.toHaveBeenCalled();expect(auth).not.toHaveBeenCalled();
});
test("an unauthenticated caller cannot read or act",async()=>{
  auth.mockResolvedValue(null);expect((await get()).status).toBe(401);expect((await POST(req())).status).toBe(401);expect(controller).not.toHaveBeenCalled();
});
test("only verified user identity reaches the controller and 202 is not paid",async()=>{
  const r=await POST(req());expect(r.status).toBe(202);expect(await r.json()).toEqual({status:"payment_confirmation_recorded"});
  expect(act).toHaveBeenCalledWith(body,f.terms.buyerId);expect(r.headers.get("cache-control")).toContain("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
});
test.each([true,false])("optional plan-scoped consent %s reaches only the authenticated owner controller",async(accepted)=>{
  const input={...body,action:"pay_now",consentVersion:"single-invoice-pay-now-v1",
    ...accepted?{futureCardConsentVersion:"same-plan-remaining-card-v1"}:{}};
  act.mockResolvedValue({status:"payment_attempt_checked",outcome:"review_required"});
  const r=await POST(req(input));expect(r.status).toBe(200);expect(act).toHaveBeenCalledWith(input,f.terms.buyerId);
  expect(r.headers.get("cache-control")).toContain("no-store");
});
test.each([{futureCardConsentVersion:true},{futureCardConsentVersion:"different-plan"},{paymentMethodId:"pm_other"},{remainingPayments:[]}])
("untrusted future-card payload %j cannot reach payment code",async(extra)=>{
  const input={...body,action:"pay_now",consentVersion:"single-invoice-pay-now-v1",...extra};
  expect((await POST(req(input))).status).toBe(400);expect(act).not.toHaveBeenCalled();
});
test.each([{buyerId:f.terms.creatorId},{amountCents:1},{accepted:false},{consentVersion:"old"}])("forged/missing consent %j never acts",async(extra)=>{
  expect((await POST(req({...body,...extra}))).status).toBe(400);expect(act).not.toHaveBeenCalled();
});
test("read is private, owner-scoped and mutation free",async()=>{
  const r=await get();expect(r.status).toBe(200);expect(read).toHaveBeenCalledWith(f.agreement.id,f.terms.buyerId);
  expect(r.headers.get("cache-control")).toContain("no-store");expect(act).not.toHaveBeenCalled();
});
test("provider/ownership failures are redacted and never described as successful payment",async()=>{
  act.mockRejectedValueOnce(new Error("SECRET client_secret https://private.stripe"));
  const r=await POST(req());expect(r.status).toBe(409);expect(await r.text()).not.toMatch(/SECRET|client_secret|private.stripe|No action was taken/);
  read.mockRejectedValueOnce(new Error("foreign owner"));expect((await get()).status).toBe(404);
});

test("bank capability is delivered only on authenticated same-origin POST with private no-store headers",async()=>{
  const input={agreementId:f.agreement.id,action:"verify_bank"};
  act.mockResolvedValueOnce({status:"bank_verification_ready",clientSecret:"pi_fixture_secret_SYNTHETIC",publishableKey:"pk_test_SYNTHETIC"});
  const r=await POST(req(input));expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("vary")).toBe("Cookie, Authorization");expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(act).toHaveBeenCalledWith(input,f.terms.buyerId);expect(read).not.toHaveBeenCalled();
});
test.each(["verify_bank","check_bank_payment"])("%s rejects unsigned and cross-origin callers",async(action)=>{
  const input={agreementId:f.agreement.id,action};expect((await POST(req(input,"https://evil.test"))).status).toBe(403);
  auth.mockResolvedValue(null);expect((await POST(req(input))).status).toBe(401);expect(act).not.toHaveBeenCalled();
});
