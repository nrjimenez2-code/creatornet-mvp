/** Exercise real HTTP handlers, mocked network only. No environment file,
 * hosted schema, Stripe account or live site is read or changed. */
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import { handoffExactInstallmentWebhook } from "../lib/installments/routeHandoff";
import { claimStripeEvent, completeStripeEvent, releaseStripeEvent } from "../lib/stripeEvents";
let db:MockClient;
const f=exactInstallmentFixture();
let session:Record<string,unknown>,event:Record<string,unknown>;
let signedIn=true,badSignature=false;
const retrieve=jest.fn(async()=>session);
jest.mock("@supabase/supabase-js",()=>({createClient:()=>db}));
jest.mock("@/lib/supabaseServer",()=>({createServerClient:()=>({auth:{getUser:async()=>({data:{user:signedIn?{id:f.terms.buyerId}:null}})}})}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({checkout:{sessions:{retrieve}},webhooks:{constructEvent:()=>{
  if(badSignature)throw new Error("invalid signature");return event;
}}})}));
jest.mock("@/lib/installments/routeHandoff",()=>({handoffExactInstallmentWebhook:jest.fn()}));
jest.mock("@/lib/stripeEvents",()=>({claimStripeEvent:jest.fn(),completeStripeEvent:jest.fn(),releaseStripeEvent:jest.fn()}));
jest.mock("@/lib/posthogServer",()=>({trackServerEvent:jest.fn()}));
jest.mock("@/lib/updateInterestScore",()=>({updateInterestScore:jest.fn()}));
jest.mock("@/lib/updatePostMetrics",()=>({updatePostMetrics:jest.fn()}));
const handoff=jest.mocked(handoffExactInstallmentWebhook),claim=jest.mocked(claimStripeEvent),
  completed=jest.mocked(completeStripeEvent),released=jest.mocked(releaseStripeEvent);
const oldEnv={...process.env};
beforeAll(()=>Object.assign(process.env,f.env,{SUPABASE_SERVICE_ROLE_KEY:"synthetic-not-a-key",STRIPE_WEBHOOK_SECRET:"whsec_synthetic"}));
afterAll(()=>{process.env=oldEnv;});
beforeEach(()=>{
  jest.clearAllMocks();signedIn=true;badSignature=false;
  process.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY="true";
  Object.assign(process.env,f.env);
  f.paid();session={...f.session,metadata:{...f.session.metadata,buyer_id:f.terms.buyerId}};
  event={livemode:false,id:"evt_synthetic",type:"checkout.session.completed",data:{object:session}};
  handoff.mockResolvedValue(true);
  claim.mockResolvedValue({status:"new",claimToken:f.terms.buyerId});
  completed.mockResolvedValue(undefined);released.mockResolvedValue(undefined);
  db=createMockClient(op=>{
    if(op.table==="exact_installment_agreements")return {data:{id:f.agreement.id,terms:f.terms,status:"active",
      purchase_id:f.terms.buyerId,purchase_seeded_at:"2026-09-05",first_fulfilled_at:"2026-09-05",
      stripe_customer_id:"cus_fixture",stripe_subscription_id:"sub_fixture",stripe_checkout_session_id:"cs_test_fixture"},error:null};
    if(op.table==="purchases")return {data:{id:f.terms.buyerId,buyer_id:f.terms.buyerId,creator_id:f.terms.creatorId,
      post_id:f.terms.postId,product_id:f.terms.productId,booking_id:f.terms.bookingId,session_id:"cs_test_fixture",
      subscription_id:"sub_fixture",status:"active",access_granted:true,paid_count:1,target_months:3,is_refund:false,is_suspect:false},error:null};
    return undefined;
  });
});
const request=()=>new Request("https://fixture.invalid/api/confirm-purchase",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session_id:"cs_test_fixture"})});
const webhookRequest=()=>({headers:{get:()=>"synthetic-signature"},text:async()=>"synthetic-body"}) as never;

test("actual confirmation route uses read-only exact result before legacy one-time upsert",async()=>{
  const {POST}=await import("../app/api/confirm-purchase/route");const response=await POST(request());
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,status:"paid",purchase_id:f.terms.buyerId});
  expect(db.ops.every(op=>op.kind==="select")).toBe(true);
  expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
});
test("browser cannot confirm another buyer's session",async()=>{
  session.metadata={...(session.metadata as object),buyer_id:f.terms.creatorId};
  const {POST}=await import("../app/api/confirm-purchase/route");expect((await POST(request())).status).toBe(403);
  expect(db.ops).toHaveLength(0);
});
test("signed-out confirmation never reaches Stripe or the service database",async()=>{
  signedIn=false;const {POST}=await import("../app/api/confirm-purchase/route");expect((await POST(request())).status).toBe(401);
  expect(retrieve).not.toHaveBeenCalled();expect(db.ops).toHaveLength(0);
});
test("missing exact schema cannot convert installment one to a full payment",async()=>{
  delete process.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY;
  const {POST}=await import("../app/api/confirm-purchase/route");expect((await POST(request())).status).toBe(500);
  expect(db.ops).toHaveLength(0);
});
test("canonical webhook acquires its event claim before handoff and completes only after successful handoff",async()=>{
  const {POST}=await import("../app/api/stripe/webhook/route");expect((await POST(webhookRequest())).status).toBe(200);
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(handoff.mock.invocationCallOrder[0]);
  expect(handoff.mock.invocationCallOrder[0]).toBeLessThan(completed.mock.invocationCallOrder[0]);
  expect(released).not.toHaveBeenCalled();expect(db.ops).toHaveLength(0);
});
test("invalid signature cannot claim or hand off an event",async()=>{
  badSignature=true;const {POST}=await import("../app/api/stripe/webhook/route");expect((await POST(webhookRequest())).status).toBe(400);
  expect(claim).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();
});
test.each(["duplicate","busy","unrecorded"] as const)("%s event claim cannot dispatch exact payment handling",async(status)=>{
  claim.mockResolvedValue({status});const {POST}=await import("../app/api/stripe/webhook/route");
  expect((await POST(webhookRequest())).status).toBe(status==="duplicate"?200:500);
  expect(handoff).not.toHaveBeenCalled();expect(completed).not.toHaveBeenCalled();
});
test("handoff failure releases the claim, returns retryable failure, and never runs legacy mutations",async()=>{
  handoff.mockRejectedValueOnce(new Error("held for reconciliation"));const {POST}=await import("../app/api/stripe/webhook/route");
  expect((await POST(webhookRequest())).status).toBe(500);
  expect(released).toHaveBeenCalledWith("stripe:evt_synthetic",f.terms.buyerId);
  expect(completed).not.toHaveBeenCalled();expect(db.ops).toHaveLength(0);
});
test("claim completion failure also remains retryable, without running the legacy switch",async()=>{
  completed.mockRejectedValueOnce(new Error("database unavailable"));const {POST}=await import("../app/api/stripe/webhook/route");
  expect((await POST(webhookRequest())).status).toBe(500);expect(released).toHaveBeenCalledTimes(1);expect(db.ops).toHaveLength(0);
});
