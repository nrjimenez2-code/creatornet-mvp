import "server-only";
import {assertAgreementId} from "./installments/agreementStore";
import {confirmFullServerPayment} from "./fullServerPayment";
import {accountFullServerPayment} from "./fullServerPaymentReadback";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original full payment lifecycle requires review");};

/** Only after canonical signature verification and the shared durable event
 * claim. The event locates an original; current status comes from the existing
 * saved-source/confirmation observation engine. This can never create a phase,
 * confirm, replace or cancel a payment, or release a purchase selection. */
export async function reconcileFullServerPaymentLifecycle(args:{buyerId:string;attemptId:string;attemptKey:string;
  eventId:string;eventCreated:number;expectedEvent:{paymentIntentId:string;livemode:boolean};env?:Record<string,string|undefined>}){
  const env=args.env??process.env;
  check(env.CREATOR_FULL_SERVER_PAYMENT_LIFECYCLE_READY==="true");
  for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
  check(/^evt_[A-Za-z0-9]+$/.test(args.eventId)&&/^pi_[A-Za-z0-9]+$/.test(args.expectedEvent.paymentIntentId)&&
    Number.isSafeInteger(args.eventCreated)&&args.eventCreated>0&&args.eventCreated<=Math.floor(Date.now()/1000));
  const original={buyerId:args.buyerId,attemptId:args.attemptId,attemptKey:args.attemptKey,expectedEvent:args.expectedEvent,env};
  const result=await confirmFullServerPayment({...original,action:{kind:"observe"}});
  check(result?.status==="observed"&&!("dispatched" in result&&result.dispatched));
  assertAgreementId(result.operationId);
  const observation=result.observation;
  check(observation&&observation.paymentIntentId===args.expectedEvent.paymentIntentId&&Number.isSafeInteger(observation.observedAt)&&
    observation.observedAt>0&&observation.observedAt<=Math.floor(Date.now()/1000));
  if(observation.status==="succeeded"){
    const accounted=await accountFullServerPayment(original);
    check(accounted.status==="original_capture_accounted");
    return {status:"original_capture_accounted" as const,paymentStatus:"succeeded" as const,releaseAllowed:false as const};
  }
  // An untouched or uncertain token phase is not a proved decline. Failure
  // without the shared engine's independent failed-charge proof stays review.
  if(observation.status==="requires_payment_method"){
    const failure=observation.failure;
    check(failure&&failure.chargeId===observation.chargeId&&failure.paymentMethodId===observation.paymentMethodId);
  }else check(["processing","requires_action","requires_confirmation","canceled"].includes(observation.status));
  return {status:"original_lifecycle_observed" as const,paymentStatus:observation.status,releaseAllowed:false as const};
}
