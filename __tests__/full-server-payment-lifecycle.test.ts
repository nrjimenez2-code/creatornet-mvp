const mockConfirm=jest.fn(),mockAccount=jest.fn();
jest.mock("../lib/fullServerPayment",()=>({confirmFullServerPayment:(...a:unknown[])=>mockConfirm(...a)}));
jest.mock("../lib/fullServerPaymentReadback",()=>({accountFullServerPayment:(...a:unknown[])=>mockAccount(...a)}));
import {reconcileFullServerPaymentLifecycle} from "../lib/fullServerPaymentLifecycle";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let result:any,now:number;
const args=()=>({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:"evt_owned",eventCreated:now-10,
  expectedEvent:{paymentIntentId:"pi_owned",livemode:false},env:{CREATOR_FULL_SERVER_PAYMENT_LIFECYCLE_READY:"true",
    CREATOR_SERVER_PAYMENT_CONFIRMATION_READY:"false",CREATOR_SERVER_PAYMENT_INTENT_READY:"false"}});
beforeEach(()=>{
  jest.resetAllMocks();now=Math.floor(Date.now()/1000);jest.useFakeTimers({now:now*1000});
  result={status:"observed",operationId:id(4),observation:{paymentIntentId:"pi_owned",status:"processing",paymentMethodId:"pm_owned",
    chargeId:"ch_owned",observedAt:now,nextActionHash:null}};
  mockConfirm.mockImplementation(async()=>result);mockAccount.mockResolvedValue({status:"original_capture_accounted"});
});
afterEach(()=>jest.useRealTimers());
test.each(["processing","requires_action","requires_confirmation","canceled"])("current %s is durably observed without accounting or release",async status=>{
  result.observation.status=status;if(status==="requires_action")result.observation.nextActionHash="a".repeat(64);
  expect(await reconcileFullServerPaymentLifecycle(args())).toEqual({status:"original_lifecycle_observed",paymentStatus:status,releaseAllowed:false});
  const {eventId:unusedId,eventCreated:unusedCreated,...original}=args();void unusedId;void unusedCreated;
  expect(mockConfirm).toHaveBeenCalledWith({...original,action:{kind:"observe"}});expect(mockAccount).not.toHaveBeenCalled();
});
test("independently proved decline remains the existing original phase with no replacement request",async()=>{
  result.observation.status="requires_payment_method";
  result.observation.failure={chargeId:"ch_owned",paymentMethodId:"pm_owned",code:"card_declined"};
  expect(await reconcileFullServerPaymentLifecycle(args())).toMatchObject({paymentStatus:"requires_payment_method",releaseAllowed:false});
  expect(mockConfirm.mock.calls[0][0].action).toEqual({kind:"observe"});expect(mockAccount).not.toHaveBeenCalled();
});
test.each(["absent proof","different failed charge","different failed method"])("%s cannot acknowledge a failed phase",async issue=>{
  result.observation.status="requires_payment_method";
  if(issue!=="absent proof")result.observation.failure={chargeId:issue==="different failed charge"?"ch_other":"ch_owned",
    paymentMethodId:issue==="different failed method"?"pm_other":"pm_owned",code:"card_declined"};
  await expect(reconcileFullServerPaymentLifecycle(args())).rejects.toThrow();expect(mockAccount).not.toHaveBeenCalled();
});
test("late lifecycle event observing success accounts the original and retains event identity",async()=>{
  result.observation.status="succeeded";mockAccount.mockResolvedValue({status:"original_capture_accounted",purchaseStatus:"refunded",accounted:false});
  expect(await reconcileFullServerPaymentLifecycle(args())).toEqual({status:"original_capture_accounted",paymentStatus:"succeeded",releaseAllowed:false});
  expect(mockAccount).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),expectedEvent:args().expectedEvent,env:args().env});
});
test("a successful provider observation with failed accounting remains retryable",async()=>{
  result.observation.status="succeeded";mockAccount.mockRejectedValue(Error("financial review"));
  await expect(reconcileFullServerPaymentLifecycle(args())).rejects.toThrow("financial review");
});
test.each(["busy","missing phase","foreign intent","future observation","capture required","dispatched"])("%s cannot acknowledge lifecycle completion",async issue=>{
  if(issue==="busy")result={status:"busy"};if(issue==="missing phase")delete result.operationId;
  if(issue==="foreign intent")result.observation.paymentIntentId="pi_other";
  if(issue==="future observation")result.observation.observedAt=now+1;
  if(issue==="capture required")result.observation.status="requires_capture";
  if(issue==="dispatched")result.dispatched=true;
  await expect(reconcileFullServerPaymentLifecycle(args())).rejects.toThrow();expect(mockAccount).not.toHaveBeenCalled();
});
test("provider/phase uncertainty cannot trigger another confirmation or selection",async()=>{
  mockConfirm.mockRejectedValue(Error("original phase requires review"));
  await expect(reconcileFullServerPaymentLifecycle(args())).rejects.toThrow("original phase requires review");
  expect(mockConfirm).toHaveBeenCalledTimes(1);expect(mockConfirm.mock.calls[0][0].action).toEqual({kind:"observe"});expect(mockAccount).not.toHaveBeenCalled();
});
test.each(["disabled","invalid event","future event"])("%s blocks lifecycle readback before calling the original composition",async issue=>{
  const a=args();if(issue==="disabled")a.env.CREATOR_FULL_SERVER_PAYMENT_LIFECYCLE_READY="false";
  if(issue==="invalid event")a.eventId="bad";if(issue==="future event")a.eventCreated=now+1;
  await expect(reconcileFullServerPaymentLifecycle(a)).rejects.toThrow();expect(mockConfirm).not.toHaveBeenCalled();
});
