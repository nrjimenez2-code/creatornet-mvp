import Stripe from "stripe";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const verifier=new Stripe("sk_test_synthetic_no_network"),secret="synthetic-lifecycle-signature";
const claim=jest.fn(),complete=jest.fn(),release=jest.fn(),observe=jest.fn(),capture=jest.fn(),boundary=jest.fn();
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const owner={buyerId:id(1),requestId:id(2),reservationId:id(3),customerId:"cus_owned",objectId:"pi_owned"};
const db=createMockClient(()=>({data:{attempt_id:id(4),payment_intent_id:"pi_owned",bound_at:"2026-01-01T00:00:00Z"},error:null}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>db}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({webhooks:verifier.webhooks})}));
jest.mock("@/lib/stripeEvents",()=>({claimStripeEvent:(...a:unknown[])=>claim(...a),completeStripeEvent:(...a:unknown[])=>complete(...a),releaseStripeEvent:(...a:unknown[])=>release(...a)}));
jest.mock("@/lib/mentorshipServerPayment",()=>({confirmBuyerMentorshipServerPayment:(...a:unknown[])=>observe(...a)}));
jest.mock("@/lib/mentorshipInstallmentWebhook",()=>({readBuyerMentorshipWebhookOwner:async()=>owner,
 handoffBuyerMentorshipRefundWebhook:async()=>false,handoffBuyerMentorshipDisputeWebhook:async()=>false,
 rejectUnimplementedBuyerInstallmentEvent:(...a:unknown[])=>boundary(...a)}));
jest.mock("@/lib/mentorshipInstallmentLaterWebhook",()=>({handoffBuyerMentorshipLaterWebhook:async()=>false}));
jest.mock("@/lib/mentorshipInstallmentFirstWebhook",()=>({handoffBuyerMentorshipFirstWebhook:async()=>false,reconcileBuyerMentorshipFirstCapture:(...a:unknown[])=>capture(...a)}));
jest.mock("@/lib/posthogServer",()=>({trackServerEvent:jest.fn()}));
jest.mock("@/lib/updateInterestScore",()=>({updateInterestScore:jest.fn()}));
jest.mock("@/lib/updatePostMetrics",()=>({updatePostMetrics:jest.fn()}));
const previous={...process.env};
beforeEach(()=>{jest.resetModules();jest.clearAllMocks();db.ops.length=0;
 process.env={...previous,VERCEL_ENV:"preview",STRIPE_SECRET_KEY:"sk_test_synthetic_no_network",STRIPE_WEBHOOK_SECRET:secret,
  NEXT_PUBLIC_SUPABASE_URL:"https://example.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic",
  CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY:"true",
  CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY:"true"};
 claim.mockResolvedValue({status:"new",claimToken:"synthetic"});complete.mockResolvedValue(undefined);release.mockResolvedValue(undefined);
 observe.mockResolvedValue({status:"observed",operationId:id(5),observation:{paymentIntentId:"pi_owned",status:"canceled",observedAt:Math.floor(Date.now()/1000)}});
 boundary.mockRejectedValue(Error("unimplemented owned event"));
 jest.spyOn(console,"log").mockImplementation(()=>{});jest.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(()=>jest.restoreAllMocks());afterAll(()=>{process.env=previous;});
async function deliver(type="payment_intent.canceled",key=secret){const payload=JSON.stringify({id:"evt_owned",object:"event",type,created:Math.floor(Date.now()/1000),livemode:false,
 api_version:"2025-10-29.clover",data:{object:{id:"pi_owned",object:"payment_intent",customer:"cus_owned",livemode:false}}});
 const signature=verifier.webhooks.generateTestHeaderString({payload,secret:key});const {POST}=await import("@/app/api/stripe/webhook/route");
 return POST(new Request("https://example.invalid/api/stripe/webhook",{method:"POST",headers:{"stripe-signature":signature},body:payload}) as any);
}
test.each(["payment_intent.processing","payment_intent.payment_failed","payment_intent.canceled","payment_intent.requires_action"])("signed %s reaches original observation before claim completion",async type=>{
 expect((await deliver(type)).status).toBe(200);expect(observe).toHaveBeenCalledTimes(1);expect(complete).toHaveBeenCalledTimes(1);
 expect(claim.mock.invocationCallOrder[0]).toBeLessThan(observe.mock.invocationCallOrder[0]);expect(observe.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
 expect(boundary).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
});
test("uncertainty releases the event claim for retry without marking completion",async()=>{
 observe.mockRejectedValue(Error("unknown original phase"));expect((await deliver()).status).toBe(500);expect(release).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();
});
test("invalid signature cannot observe or claim",async()=>{expect((await deliver(undefined,"wrong")).status).toBe(400);expect(claim).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();});
test("completed duplicate never observes again",async()=>{claim.mockResolvedValue({status:"duplicate"});expect((await deliver()).status).toBe(200);expect(observe).not.toHaveBeenCalled();});
test("disabled lifecycle keeps the protective owned-event rejection",async()=>{delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY;
 expect((await deliver()).status).toBe(500);expect(observe).not.toHaveBeenCalled();expect(boundary).toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
});
