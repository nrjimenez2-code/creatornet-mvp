import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockOwner=jest.fn(),mockConfirm=jest.fn(),mockCapture=jest.fn();
jest.mock("../lib/mentorshipInstallmentWebhook",()=>({readBuyerMentorshipWebhookOwner:(...a:unknown[])=>mockOwner(...a)}));
jest.mock("../lib/mentorshipServerPayment",()=>({confirmBuyerMentorshipServerPayment:(...a:unknown[])=>mockConfirm(...a)}));
jest.mock("../lib/mentorshipInstallmentFirstWebhook",()=>({reconcileBuyerMentorshipFirstCapture:(...a:unknown[])=>mockCapture(...a)}));
import {handoffBuyerMentorshipManualLifecycle} from "../lib/mentorshipInstallmentManualLifecycle";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let row:any,error:any,result:any,owner:any,event:any,env:any;
const admin=createMockClient(op=>{if(op.table!=="server_payment_intent_operations_v1")throw Error("Unexpected read");return {data:row,error};});
beforeEach(()=>{jest.resetAllMocks();admin.ops.length=0;const now=Math.floor(Date.now()/1000);
 owner={buyerId:id(1),requestId:id(2),reservationId:id(3),customerId:"cus_owned",objectId:"pi_owned"};
 row={attempt_id:id(4),payment_intent_id:"pi_owned",bound_at:new Date().toISOString()};error=null;
 event={id:"evt_owned",created:now-1,type:"payment_intent.processing",livemode:false,data:{object:{}}};
 env={CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY:"true",
  CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY:"true"};
 result={status:"observed",operationId:id(5),observation:{paymentIntentId:"pi_owned",status:"processing",observedAt:now,chargeId:"ch_owned",paymentMethodId:"pm_owned"}};
 mockOwner.mockImplementation(async()=>owner);mockConfirm.mockImplementation(async()=>result);
});
const run=()=>handoffBuyerMentorshipManualLifecycle({event,admin:admin as any,env});
test.each(["payment_intent.processing","payment_intent.payment_failed","payment_intent.canceled","payment_intent.requires_action"])("%s observes the original only",async type=>{
 event.type=type;expect(await run()).toBe(true);
 expect(mockConfirm).toHaveBeenCalledWith({buyerId:id(1),requestId:id(2),env,action:{kind:"observe"},
  expectedEvent:{paymentIntentId:"pi_owned",customerId:"cus_owned",livemode:false}});
 expect(mockCapture).not.toHaveBeenCalled();expect(admin.opsFor("server_payment_intent_operations_v1")[0].filters).toEqual({payment_intent_id:"pi_owned"});
});
test.each(["processing","requires_action","requires_confirmation","canceled"])("current %s does not account or release",async status=>{
 result.observation.status=status;expect(await run()).toBe(true);expect(mockCapture).not.toHaveBeenCalled();
});
test("late failure event with current success uses existing first receipt and financial handling",async()=>{
 event.type="payment_intent.payment_failed";result.observation.status="succeeded";expect(await run()).toBe(true);
 expect(mockCapture).toHaveBeenCalledWith({event,admin,env,owner,objectType:"payment_intent"});
});
test("receipt failure stays retryable after success observation",async()=>{
 result.observation.status="succeeded";mockCapture.mockRejectedValue(Error("accounting pending"));await expect(run()).rejects.toThrow("accounting pending");
});
test("proved decline is observed without issuing replacement",async()=>{
 result.observation.status="requires_payment_method";result.observation.failure={chargeId:"ch_owned",paymentMethodId:"pm_owned"};
 expect(await run()).toBe(true);expect(mockCapture).not.toHaveBeenCalled();expect(mockConfirm.mock.calls[0][0].action).toEqual({kind:"observe"});
});
test.each(["no failed charge","wrong failed charge","wrong failed method","missing phase","foreign intent","future observation","dispatched","busy","requires capture","lookup error","unbound","accounting gated"])("%s remains retryable",async issue=>{
 if(issue.includes("failed")){result.observation.status="requires_payment_method";if(issue!=="no failed charge")result.observation.failure={chargeId:issue==="wrong failed charge"?"ch_other":"ch_owned",paymentMethodId:issue==="wrong failed method"?"pm_other":"pm_owned"};}
 if(issue==="missing phase")delete result.operationId;if(issue==="foreign intent")result.observation.paymentIntentId="pi_other";
 if(issue==="future observation")result.observation.observedAt+=60;if(issue==="dispatched")result.dispatched=true;
 if(issue==="busy")result={status:"busy"};if(issue==="requires capture")result.observation.status="requires_capture";
 if(issue==="lookup error")error={message:"unavailable"};if(issue==="unbound")row.bound_at=null;
 if(issue==="accounting gated"){result.observation.status="succeeded";env.CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY="false";}
 await expect(run()).rejects.toThrow();expect(mockCapture).not.toHaveBeenCalled();
});
test.each(["unowned","legacy","disabled","unrelated"])("%s leaves routing to the existing boundary",async issue=>{
 if(issue==="unowned")owner=null;if(issue==="legacy")row=null;if(issue==="disabled")delete env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY;
 if(issue==="unrelated")event.type="invoice.created";expect(await run()).toBe(false);expect(mockConfirm).not.toHaveBeenCalled();
});
