"use client";
import Link from "next/link";
import {useEffect,useRef,useState} from "react";
import {loadStripe,type Stripe,type StripeElements,type StripeAddressElement,type StripePaymentElement} from "@stripe/stripe-js";
import {createClient} from "@/lib/supabaseClient";
import {getActionSession} from "@/lib/actionSession";
import {prepareSessionNavigation} from "@/lib/browserSession";
import {useTeamApi} from "@/lib/salesTeams/client";
import TeamBuyerLifecycle from "./TeamBuyerLifecycle";
import TeamBuyerRetry from "./TeamBuyerRetry";
import type {TeamSavedMethodQuote,TeamSavedMethodAcceptance} from "@/lib/salesTeams/savedMethod";

type Payment={phase:string;amountCents:number;currency:string;saveForFuture:boolean;obligationId?:string;periodNumber?:number;retryAttempt?:boolean;automaticAttempt?:boolean;automaticDebitsStopped?:boolean;clientSecret?:string;pendingRequest:{id:string;kind:"token"|"reconfirm"|"saved_method"|"saved_reconfirm"}|null};
type Pending={id:string;kind:"token"|"reconfirm";token?:string;obligationId?:string;savedMethodConsent?:TeamSavedMethodAcceptance};
type NextPayment={status:"due"|"not_due"|"complete";periodNumber?:number;amountCents?:number;dueAt?:string};
export type PaymentResponse={payment:Payment;collectionEnabled:boolean;nextPayment?:NextPayment;laterCollectionEnabled?:boolean;lifecycleAvailable?:boolean;retryAvailable?:boolean;savedMethodConsentRequired?:boolean;savedMethodConsentEnabled?:boolean;savedMethodConsent?:TeamSavedMethodQuote|null;savedMethodStatus?:string};
type Elements={stripe:Stripe;elements:StripeElements;payment:StripePaymentElement;address:StripeAddressElement};
const descriptions:Record<string,string>={not_started:"Prepare your payment to enter card details.",needs_method:"Enter your card and complete US billing address.",authentication_required:"Your bank needs you to verify the saved card for this original payment.",requires_action:"Your bank needs to verify this payment.",
 requires_confirmation:"Bank verification is complete. Continue to finish your payment.",processing:"Your original payment is processing. Check its status before taking another action.",
 captured_pending_receipt:"Stripe reports this payment captured. CreatorNet is verifying the receipt before access is delivered.",receipt_verified:"Your payment receipt is verified. Delivery is being prepared.",payment_review:"Your captured payment is under financial review. Check its status for an update.",paid:"Your payment receipt is verified. Your purchase is in your Library.",
 stop_pending:"Stop is saved. The original payment must be reconciled before it can be safely closed.",stopped:"This payment is safely closed unpaid. Ask your closer for a new review to choose another approved option.",later_stopped:"This later payment was canceled and future automatic debits are stopped. Your earlier paid purchase remains in your Library; any remaining contractual balance requires review.",canceled:"The original payment was canceled. Choose Stop to close this unpaid purchase.",review_required:"Check the original payment before continuing."};
export default function TeamBuyerPayment({saleId,userId}:{saleId:string;userId:string}){
 const api=useTeamApi(),[view,setView]=useState<Payment|null>(null),[enabled,setEnabled]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[pending,setPending]=useState<Pending|null>(null);
 const [nextPayment,setNextPayment]=useState<NextPayment|undefined>(),[laterEnabled,setLaterEnabled]=useState(false);
 const [lifecycleAvailable,setLifecycleAvailable]=useState(false);
 const [retryAvailable,setRetryAvailable]=useState(false),[planRevision,setPlanRevision]=useState(0);
 const [consent,setConsent]=useState<TeamSavedMethodQuote|null>(null),[consentRequired,setConsentRequired]=useState(false),[consentEnabled,setConsentEnabled]=useState(false),[consentAccepted,setConsentAccepted]=useState(false),[savedMethodStatus,setSavedMethodStatus]=useState<string|undefined>();
 const mounted=useRef(true),busyRef=useRef(false),paymentNode=useRef<HTMLDivElement>(null),addressNode=useRef<HTMLDivElement>(null),provider=useRef<Elements|null>(null);
 const storageKey=`creatornet-team-confirmation-v1:${userId}:${saleId}`,path=`/api/sales-team/sales/${encodeURIComponent(saleId)}/payment`;
 const applyConsent=(data:PaymentResponse)=>{if(data.savedMethodConsent?.fingerprint!==consent?.fingerprint)setConsentAccepted(false);setConsent(data.savedMethodConsent??null);setConsentRequired(data.savedMethodConsentRequired===true);setConsentEnabled(data.savedMethodConsentEnabled===true);setSavedMethodStatus(data.savedMethodStatus);};
 const update=(data:PaymentResponse)=>{if(mounted.current){applyConsent(data);if(data.payment.retryAttempt&&data.payment.obligationId&&pending&&pending.obligationId!==data.payment.obligationId){sessionStorage.removeItem(storageKey);setPending(null);}if(data.payment.phase!==view?.phase||data.payment.amountCents!==view?.amountCents||data.payment.saveForFuture!==view?.saveForFuture||data.payment.obligationId!==view?.obligationId)setReady(false);setView(data.payment);setEnabled(data.collectionEnabled);setNextPayment(data.nextPayment);setLaterEnabled(data.laterCollectionEnabled===true);setLifecycleAvailable(data.lifecycleAvailable===true);setRetryAvailable(data.retryAvailable===true);setPlanRevision(n=>n+1);}};
 useEffect(()=>{mounted.current=true;const controller=new AbortController();
  let saved:Pending|null=null,storageError:string|null=null;
  try{const value=JSON.parse(sessionStorage.getItem(storageKey)||"null");if(value&&typeof value.id==="string"&&["token","reconfirm"].includes(value.kind))saved=value;}catch{storageError="The original confirmation needs review before another payment.";}
  void api(path,undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setConsentAccepted(false);setConsent(data.savedMethodConsent??null);setConsentRequired(data.savedMethodConsentRequired===true);setConsentEnabled(data.savedMethodConsentEnabled===true);setSavedMethodStatus(data.savedMethodStatus);if(data.payment.retryAttempt&&data.payment.obligationId&&saved&&saved.obligationId!==data.payment.obligationId){sessionStorage.removeItem(storageKey);saved=null;}setPending(saved);setView(data.payment);setEnabled(data.collectionEnabled);setNextPayment(data.nextPayment);setLaterEnabled(data.laterCollectionEnabled===true);setLifecycleAvailable(data.lifecycleAvailable===true);setRetryAvailable(data.retryAvailable===true);if(storageError)setError(storageError);}}).catch(e=>{if(!controller.signal.aborted){setPending(saved);setError(e.message);}});
  return()=>{mounted.current=false;controller.abort();};
 },[api,path,storageKey]);
 useEffect(()=>{
  if(view?.phase!=="needs_method"||!paymentNode.current||!addressNode.current)return;
  let disposed=false;
  void loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY||"").then(stripe=>{
   if(disposed||!stripe||!paymentNode.current||!addressNode.current)return;
   const elements=stripe.elements({mode:"payment",amount:view.amountCents,currency:"usd",paymentMethodTypes:["card"],captureMethod:"automatic_async",...(view.saveForFuture?{setupFutureUsage:"off_session" as const}:{})});
   const payment=elements.create("payment",{fields:{billingDetails:{address:"never",name:"never"}}}),address=elements.create("address",{mode:"billing",allowedCountries:["US"]});
   provider.current={stripe,elements,payment,address};payment.on("ready",()=>{if(!disposed)setReady(true);});payment.mount(paymentNode.current);address.mount(addressNode.current);
  }).catch(()=>{if(!disposed)setError("Payment details could not load. Refresh the original payment to try again.");});
  return()=>{disposed=true;provider.current?.payment.destroy();provider.current?.address.destroy();provider.current=null;};
 },[view?.phase,view?.amountCents,view?.saveForFuture,view?.obligationId]);
 const freshSession=async()=>{
  const client=createClient();if(!await prepareSessionNavigation(client))throw Error("Sign in again before continuing payment.");const session=await getActionSession();
  if(session.error||session.data.session?.user.id!==userId||!mounted.current)throw Error("Your signed-in account changed. Reload this purchase before continuing.");
 };
 const save=(value:Pending|null)=>{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);if(mounted.current)setPending(value);};
 const act=async(action:string)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);
  try{
   const selected=view?.obligationId?{obligation_id:view.obligationId}:{};
   let body:Record<string,unknown>={action,...(action==="prepare_next"?{}:selected)};
   if(["prepare","prepare_next","pay","authenticate","reconfirm"].includes(action))await freshSession();
   if(action==="pay"){
    if(pending||view?.pendingRequest)throw Error("Check the original confirmation before entering another payment.");
    if(consentRequired&&(!consentEnabled||!consent||!consentAccepted))throw Error("Review and accept the saved-card terms before continuing.");
    const p=provider.current;if(!p||!ready)throw Error("Wait for payment details to load.");const submitted=await p.elements.submit();if(submitted.error)throw Error(submitted.error.message||"Review your payment details.");
    const billing=await p.address.getValue();if(!billing.complete||billing.value.address.country!=="US")throw Error("Enter a complete US billing address.");
    const token=await p.stripe.createConfirmationToken({elements:p.elements,params:{payment_method_data:{billing_details:{name:billing.value.name,address:billing.value.address}},return_url:new URL(`/purchase/team/${saleId}`,window.location.origin).toString()}});
    if(token.error||!token.confirmationToken)throw Error(token.error?.message||"Payment details need review.");await freshSession();
    const acceptance=consentRequired&&consent?{savedMethodConsent:{accepted:true as const,fingerprint:consent.fingerprint}}:{};
    const request={id:crypto.randomUUID(),kind:"token" as const,token:token.confirmationToken.id,...(view?.obligationId?{obligationId:view.obligationId}:{}),...acceptance};save(request);body={action:"confirm",request_id:request.id,confirmation_token:request.token,...selected,...(request.savedMethodConsent?{saved_method_consent:request.savedMethodConsent}:{})};
   }else if(action==="reconfirm"){
    const request={id:crypto.randomUUID(),kind:"reconfirm" as const,...(view?.obligationId?{obligationId:view.obligationId}:{})};save(request);body={action:"reconfirm",request_id:request.id,...selected};
   }else if(action==="resume"){
    const request=pending??view?.pendingRequest;if(!request)throw Error("Refresh this payment to locate its original confirmation.");
    body={action:"resume",request_id:request.id,...(pending?.token?{confirmation_token:pending.token}:{}),...(pending?pending.obligationId?{obligation_id:pending.obligationId}:{}:selected),...(pending?.savedMethodConsent?{saved_method_consent:pending.savedMethodConsent}:{})};
   }else if(action==="authenticate"){
    if(!view?.clientSecret){update(await api(path,{action:"refresh",...selected}));return;}
    const stripe=await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY||"");if(!stripe)throw Error("Bank verification could not load.");
    const result=await stripe.handleNextAction({clientSecret:view.clientSecret});if(result.error)throw Error(result.error.message||"Bank verification needs review.");await freshSession();body={action:"refresh",...selected};
   }
   const data=await api(path,body);update(data);if(["pay","reconfirm","resume"].includes(action))save(null);
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The original payment needs review.");}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const unresolved=pending??view?.pendingRequest;
 return <section className="space-y-4" aria-busy={busy}>
  <h2>Payment</h2>{error?<p role="alert">{error}</p>:null}<p role="status">{view?descriptions[view.phase]??descriptions.review_required:"Loading your payment…"}</p>
  {view?.periodNumber?<p>Payment {view.periodNumber} of your accepted plan.</p>:null}
  {view?.phase==="needs_method"?<><div ref={paymentNode}/><div ref={addressNode}/></>:null}
  {view?.phase==="needs_method"&&consentRequired?<fieldset disabled={busy||!consentEnabled||!!unresolved} className="space-y-2"><legend>Saved card permission</legend>
   {consent?<><p>{consent.authorization}</p><p>{consent.paymentKind==="installments"?`Accepted payments: ${consent.payments.map(p=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(p.amountCents/100)).join(", ")}.`:`${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(consent.monthlyAmountCents/100)} monthly; minimum ${consent.minimumMonths} months.${consent.autoRenew?" Renews monthly after the minimum until renewal is stopped.":" Ends after the accepted minimum."}`}</p><p>{consent.acceptedBilling}</p>
    <label><input type="checkbox" checked={consentAccepted} onChange={event=>setConsentAccepted(event.target.checked)}/>{consent.automaticAuthorized?"I agree to the saved-card and automatic-payment terms above.":"I agree to save this card for manual payments only."}</label></>:<p>Refresh this payment to review its saved-card terms.</p>}
  </fieldset>:null}
  {savedMethodStatus==="review_required"?<p role="status">Your payment receipt is separate from saved-card permission. The saved card needs review before automatic payments can use it.</p>:null}
  {view?.phase==="not_started"?<button disabled={busy||!enabled} onClick={()=>void act("prepare")}>Prepare payment</button>:null}
  {view?.phase==="needs_method"&&!unresolved?<button disabled={busy||!enabled||!ready||consentRequired&&(!consentEnabled||!consent||!consentAccepted)} onClick={()=>void act("pay")}>Pay {new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(view.amountCents/100)}</button>:null}
  {view?.phase==="requires_action"?<button disabled={busy} onClick={()=>void act("authenticate")}>Verify with your bank</button>:null}
  {view?.phase==="authentication_required"&&!unresolved?<button disabled={busy||!enabled} onClick={()=>void act("reconfirm")}>Verify saved card</button>:null}
  {view?.phase==="authentication_required"&&view.automaticAttempt&&!unresolved?<button disabled={busy||!enabled} onClick={()=>void act("prepare")}>Use another card</button>:null}
  {view?.phase==="requires_confirmation"&&!unresolved?<button disabled={busy||!enabled} onClick={()=>void act("reconfirm")}>Complete payment</button>:null}
  {unresolved?<button disabled={busy} onClick={()=>void act("resume")}>Check original confirmation</button>:null}
  <button disabled={busy} onClick={()=>void act("refresh")}>Refresh payment status</button>
  {view&&["paid","later_stopped"].includes(view.phase)?<Link href="/library">Open Library</Link>:null}
  {nextPayment?.status==="not_due"&&nextPayment.dueAt?<p>Payment {nextPayment.periodNumber} is due {new Date(nextPayment.dueAt).toLocaleString()}.</p>:null}
  {nextPayment?.status==="due"&&!unresolved&&!view?.automaticDebitsStopped?<button disabled={busy||!laterEnabled} onClick={()=>void act("prepare_next")}>Prepare payment {nextPayment.periodNumber}</button>:null}
  {nextPayment?.status==="complete"?<p>All payments in your accepted schedule are covered.</p>:null}
  {!lifecycleAvailable&&view?.saveForFuture&&["paid","captured_pending_receipt","receipt_verified","payment_review"].includes(view.phase)?view.automaticDebitsStopped?<p>Future automatic debits are stopped. Any remaining contractual balance requires review.</p>:<button disabled={busy} onClick={()=>void act("stop")}>Stop future automatic payments</button>:null}
  {view&&!["paid","stopped","later_stopped","captured_pending_receipt","receipt_verified","payment_review"].includes(view.phase)?<button disabled={busy} onClick={()=>void act("stop")}>Stop this payment</button>:null}
  {lifecycleAvailable?<TeamBuyerLifecycle saleId={saleId} userId={userId} paymentPhase={view?.phase} refreshKey={planRevision} onPayment={update}/>:null}
  {retryAvailable&&view&&(view.periodNumber&&view.periodNumber>1||view.saveForFuture&&["paid","receipt_verified","payment_review"].includes(view.phase))?<TeamBuyerRetry saleId={saleId} userId={userId} originalObligationId={["paid","receipt_verified","payment_review"].includes(view.phase)?null:view.obligationId??null} refreshKey={planRevision} showReview={!["paid","receipt_verified","payment_review","processing","captured_pending_receipt"].includes(view.phase)} onPayment={update}/>:null}
 </section>;
}
