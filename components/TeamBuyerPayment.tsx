"use client";
import {useEffect,useRef,useState} from "react";
import {loadStripe,type Stripe,type StripeElements,type StripeAddressElement,type StripePaymentElement} from "@stripe/stripe-js";
import {createClient} from "@/lib/supabaseClient";
import {prepareSessionNavigation} from "@/lib/browserSession";
import {useTeamApi} from "@/lib/salesTeams/client";

type Payment={phase:string;amountCents:number;currency:string;saveForFuture:boolean;clientSecret?:string;pendingRequest:{id:string;kind:"token"|"reconfirm"}|null};
type Pending={id:string;kind:"token"|"reconfirm";token?:string};
type Elements={stripe:Stripe;elements:StripeElements;payment:StripePaymentElement;address:StripeAddressElement};
const descriptions:Record<string,string>={not_started:"Prepare your payment to enter card details.",needs_method:"Enter your card and complete US billing address.",requires_action:"Your bank needs to verify this payment.",
 requires_confirmation:"Bank verification is complete. Continue to finish your payment.",processing:"Your original payment is processing. Check its status before taking another action.",
 captured_pending_receipt:"Stripe reports this payment captured. CreatorNet is verifying the receipt before access is delivered.",paid:"Your payment receipt is verified.",
 stop_pending:"Stop is saved. The original payment must be reconciled before it can be safely closed.",stopped:"This payment is safely closed unpaid. Ask your closer for a new review to choose another approved option.",canceled:"The original payment was canceled. Choose Stop to close this unpaid purchase.",review_required:"Check the original payment before continuing."};
export default function TeamBuyerPayment({saleId,userId}:{saleId:string;userId:string}){
 const api=useTeamApi(),[view,setView]=useState<Payment|null>(null),[enabled,setEnabled]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[pending,setPending]=useState<Pending|null>(null);
 const mounted=useRef(true),busyRef=useRef(false),paymentNode=useRef<HTMLDivElement>(null),addressNode=useRef<HTMLDivElement>(null),provider=useRef<Elements|null>(null);
 const storageKey=`creatornet-team-confirmation-v1:${userId}:${saleId}`,path=`/api/sales-team/sales/${encodeURIComponent(saleId)}/payment`;
 const update=(data:{payment:Payment;collectionEnabled:boolean})=>{if(mounted.current){if(data.payment.phase!==view?.phase||data.payment.amountCents!==view?.amountCents||data.payment.saveForFuture!==view?.saveForFuture)setReady(false);setView(data.payment);setEnabled(data.collectionEnabled);}};
 useEffect(()=>{mounted.current=true;const controller=new AbortController();
  let saved:Pending|null=null,storageError:string|null=null;
  try{const value=JSON.parse(sessionStorage.getItem(storageKey)||"null");if(value&&typeof value.id==="string"&&["token","reconfirm"].includes(value.kind))saved=value;}catch{storageError="The original confirmation needs review before another payment.";}
  void api(path,undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setPending(saved);setView(data.payment);setEnabled(data.collectionEnabled);if(storageError)setError(storageError);}}).catch(e=>{if(!controller.signal.aborted){setPending(saved);setError(e.message);}});
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
 },[view?.phase,view?.amountCents,view?.saveForFuture]);
 const freshSession=async()=>{
  const client=createClient();if(!await prepareSessionNavigation(client))throw Error("Sign in again before continuing payment.");const session=await client.auth.getSession();
  if(session.error||session.data.session?.user.id!==userId||!mounted.current)throw Error("Your signed-in account changed. Reload this purchase before continuing.");
 };
 const save=(value:Pending|null)=>{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);if(mounted.current)setPending(value);};
 const act=async(action:string)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);
  try{
   let body:Record<string,unknown>={action};
   if(["prepare","pay","authenticate","reconfirm"].includes(action))await freshSession();
   if(action==="pay"){
    if(pending||view?.pendingRequest)throw Error("Check the original confirmation before entering another payment.");
    const p=provider.current;if(!p||!ready)throw Error("Wait for payment details to load.");const submitted=await p.elements.submit();if(submitted.error)throw Error(submitted.error.message||"Review your payment details.");
    const billing=await p.address.getValue();if(!billing.complete||billing.value.address.country!=="US")throw Error("Enter a complete US billing address.");
    const token=await p.stripe.createConfirmationToken({elements:p.elements,params:{payment_method_data:{billing_details:{name:billing.value.name,address:billing.value.address}},return_url:new URL(`/purchase/team/${saleId}`,window.location.origin).toString()}});
    if(token.error||!token.confirmationToken)throw Error(token.error?.message||"Payment details need review.");await freshSession();
    const request={id:crypto.randomUUID(),kind:"token" as const,token:token.confirmationToken.id};save(request);body={action:"confirm",request_id:request.id,confirmation_token:request.token};
   }else if(action==="reconfirm"){
    const request={id:crypto.randomUUID(),kind:"reconfirm" as const};save(request);body={action:"reconfirm",request_id:request.id};
   }else if(action==="resume"){
    const request=pending??view?.pendingRequest;if(!request)throw Error("Refresh this payment to locate its original confirmation.");
    body={action:"resume",request_id:request.id,...(pending?.token?{confirmation_token:pending.token}:{})};
   }else if(action==="authenticate"){
    if(!view?.clientSecret){update(await api(path,{action:"refresh"}));return;}
    const stripe=await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY||"");if(!stripe)throw Error("Bank verification could not load.");
    const result=await stripe.handleNextAction({clientSecret:view.clientSecret});if(result.error)throw Error(result.error.message||"Bank verification needs review.");await freshSession();body={action:"refresh"};
   }
   const data=await api(path,body);update(data);if(["pay","reconfirm","resume"].includes(action))save(null);
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The original payment needs review.");}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const unresolved=pending??view?.pendingRequest;
 return <section className="space-y-4" aria-busy={busy}>
  <h2>Payment</h2>{error?<p role="alert">{error}</p>:null}<p role="status">{view?descriptions[view.phase]??descriptions.review_required:"Loading your payment…"}</p>
  {view?.phase==="needs_method"?<><div ref={paymentNode}/><div ref={addressNode}/></>:null}
  {view?.phase==="not_started"?<button disabled={busy||!enabled} onClick={()=>void act("prepare")}>Prepare payment</button>:null}
  {view?.phase==="needs_method"&&!unresolved?<button disabled={busy||!enabled||!ready} onClick={()=>void act("pay")}>Pay {new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(view.amountCents/100)}</button>:null}
  {view?.phase==="requires_action"?<button disabled={busy} onClick={()=>void act("authenticate")}>Verify with your bank</button>:null}
  {view?.phase==="requires_confirmation"&&!unresolved?<button disabled={busy||!enabled} onClick={()=>void act("reconfirm")}>Complete payment</button>:null}
  {unresolved?<button disabled={busy} onClick={()=>void act("resume")}>Check original confirmation</button>:null}
  <button disabled={busy} onClick={()=>void act("refresh")}>Refresh payment status</button>
  {view&&!["paid","stopped","captured_pending_receipt"].includes(view.phase)?<button disabled={busy} onClick={()=>void act("stop")}>Stop this payment</button>:null}
 </section>;
}
