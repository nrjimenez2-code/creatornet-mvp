"use client";
import {useEffect,useRef,useState} from "react";
import {loadStripe,type Stripe,type StripeElements,type StripeCardElement,type StripeAddressElement} from "@stripe/stripe-js";
import {manualPaymentEndpoint,readManualAction,saveManualAction,type ManualPaymentScope,type SavedManualAction} from "@/lib/manualPaymentBrowser";
import type {ManualPaymentAction} from "@/lib/manualPaymentAction";

type Props=ManualPaymentScope&{ensureSelection?:()=>Promise<void>;onReleased:(releasedAt:string)=>void;onPayoffAbandoned?:()=>void;allowNewPayment?:boolean};
const money=(amount:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(amount/100);
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export default function ManualMentorshipPayment(props:Props){
  const addressHost=useRef<HTMLDivElement>(null),paymentHost=useRef<HTMLDivElement>(null);
  const sdk=useRef<{stripe:Stripe;elements:StripeElements;address:StripeAddressElement;card:StripeCardElement}|null>(null);
  const lock=useRef(false),alive=useRef(true);
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [view,setView]=useState<any>(null),[hasSaved,setHasSaved]=useState(false);
  const identity=JSON.stringify([props.requestId,props.buyerId,props.productId,props.mode,props.amountCents]);
  useEffect(()=>{
    alive.current=true;let disposed=false;let cleanup=()=>{};
    setReady(false);setView(null);setMessage("");
    try{setHasSaved(Boolean(readManualAction(localStorage,props)));}catch{setMessage("Your saved payment needs review. Check its status before continuing.");}
    void (async()=>{
      const key=process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;if(!key)throw Error();
      const stripe=await loadStripe(key);if(!stripe||disposed||!addressHost.current||!paymentHost.current)return;
      const elements=stripe.elements({appearance:{theme:"night"}});
      const address=elements.create("address",{mode:"billing",allowedCountries:["US"]});
      const payment=elements.create("card",{hidePostalCode:true,style:{base:{color:"#ffffff",fontSize:"16px"}}});
      cleanup=()=>{payment.destroy();address.destroy();sdk.current=null;};
      payment.on("ready",()=>{if(!disposed)setReady(true);});
      payment.on("loaderror",()=>{if(!disposed)setMessage("The payment form could not load. Reload this original checkout.");});
      address.mount(addressHost.current);payment.mount(paymentHost.current);sdk.current={stripe,elements,address,card:payment};
    })().catch(()=>{if(!disposed)setMessage("The payment form is unavailable. Keep this checkout and try again later.");});
    return()=>{disposed=true;alive.current=false;cleanup();};
  },[identity]);
  async function action(value:ManualPaymentAction|{kind:"stop";confirmed:true}){
    if(alive.current)setView(null);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try{
      const response=await fetch(manualPaymentEndpoint(props),{method:"POST",credentials:"include",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
      const body=await response.json();
      if(body.requestId!==props.requestId)throw Error(body.error||"Your original payment needs review.");
      if(body.status==="released"&&body.canSwitchPaymentMode===true&&typeof body.releasedAt==="string"&&
        Number.isFinite(Date.parse(body.releasedAt))&&Date.parse(body.releasedAt)>0&&Date.parse(body.releasedAt)<=Date.now()+5000){
        if(alive.current){setView(body);props.onReleased(body.releasedAt);}return body;
      }
      if(body.status==="abandoned"&&props.mode==="monthly_payoff"&&response.ok){
        if(alive.current){setView(body);props.onPayoffAbandoned?.();}return body;
      }
      if(!response.ok)throw Error(body.error||"Your original payment needs reconciliation. Check its status before trying again.");
      if(alive.current)setView(body);return body;
    }finally{clearTimeout(timer);}
  }
  async function run(task:()=>Promise<void>,payable=false){
    if(lock.current)return;lock.current=true;setBusy(true);setMessage("");setView(null);
    try{
      if(payable&&!navigator.locks)throw Error("Use a browser that supports secure checkout coordination to submit this payment.");
      if(navigator.locks)await navigator.locks.request(`creatornet-payment:${props.buyerId}:${props.mode}:${props.requestId}`,task);
      else await task();
    }catch(error){if(alive.current)setMessage(error instanceof Error?error.message:"The result is uncertain. Check this payment's status.");}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  async function pay(replace=false){
    await run(async()=>{
      if(!sdk.current)throw Error("Wait for the payment form to load.");
      const saved=readManualAction(localStorage,props);
      if(saved&&!replace){await action(saved);return;}
      if(replace&&(!uuid(view?.operationId)||view.paymentStatus!=="requires_payment_method"||view.replacementAllowed!==true))throw Error("Check your original payment before replacing its card.");
      if(replace){
        const fresh=await action({kind:"observe"});
        if(fresh.operationId!==view.operationId||fresh.paymentStatus!=="requires_payment_method"||fresh.replacementAllowed!==true)
          throw Error("Your payment changed. Check its current status before replacing the card.");
      }
      if(!replace){
        await props.ensureSelection?.();const prepared=await action({kind:"prepare"});
        if(prepared.status!=="payment_prepared"||prepared.amountCents!==props.amountCents||prepared.currency!=="usd")throw Error("Your original payment could not be prepared.");
      }
      const {stripe,address,card}=sdk.current;
      const billing=await address.getValue();if(!billing.complete||billing.value.address.country!=="US")throw Error("Enter a complete US billing address.");
      const method=await stripe.createPaymentMethod({type:"card",card,billing_details:{name:billing.value.name,address:billing.value.address}});
      if(method.error||!method.paymentMethod)throw Error(method.error?.message||"Your payment details could not be saved.");
      const next:SavedManualAction=replace?{kind:"card_replacement",paymentMethodId:method.paymentMethod.id,previousOperationId:view.operationId}:
        {kind:"card",paymentMethodId:method.paymentMethod.id};
      saveManualAction(localStorage,props,next);setHasSaved(true);await action(next);
    },true);
  }
  async function authenticate(){await run(async()=>{
    if(!sdk.current||!uuid(view?.operationId))throw Error("Check the payment status first.");
    const capability=await action({kind:"authenticate",operationId:view.operationId});
    if(capability.status!=="authentication_required"||capability.operationId!==view.operationId||typeof capability.clientSecret!=="string")throw Error("Bank verification is unavailable.");
    const result=await sdk.current.stripe.handleCardAction(capability.clientSecret);
    // A browser challenge result never counts money or authorizes replacement.
    await action({kind:"observe"});if(result.error)throw Error(result.error.message||"Bank verification needs another check.");
  });}
  async function afterAuthentication(){await run(async()=>{
    if(view?.paymentStatus!=="requires_confirmation"||!uuid(view.operationId))throw Error("Check your payment status first.");
    const fresh=await action({kind:"observe"});
    if(fresh.operationId!==view.operationId||fresh.paymentStatus!=="requires_confirmation")throw Error("Your payment changed. Check its current status.");
    const next:SavedManualAction={kind:"after_authentication",previousOperationId:view.operationId};
    saveManualAction(localStorage,props,next);setHasSaved(true);await action(next);
  },true);}
  const terminal=view?.status==="released"||view?.status==="abandoned"||view?.status==="payment_accounted";
  return <section className="space-y-4 rounded-xl border p-5" aria-label="Pay for your mentorship">
    <h2 className="text-xl font-semibold">{props.mode==="installments"?"First installment":props.mode==="monthly_first"?"First month":props.mode==="monthly_payoff"?"Remaining minimum payoff":"Full payment"}: {money(props.amountCents)}</h2>
    <p>Use a US-issued card and US billing address. Stripe securely collects your payment details.</p>
    <div ref={addressHost}/><div ref={paymentHost}/>
    {view?.status==="payment_accounted"&&<p role="status">{props.mode==="monthly_payoff"?"Your payoff was recorded. Check your membership for paid service and renewal-stop status.":"Your payment was recorded. Check your purchase for service access"+(props.mode==="installments"?" and the remaining payment schedule":"")+"."}</p>}
    {view?.status==="released"&&<p role="status">This unpaid checkout was released. You can review the offer and choose another payment option.</p>}
    {view?.status==="abandoned"&&<p role="status">This unpaid payoff was closed. Your existing membership terms remain in place.</p>}
    {view?.status==="payment_observed"&&<p role="status">{view.paymentStatus==="processing"?"Your payment is processing. Check its status before taking another action.":view.paymentStatus==="requires_action"?"Your bank requires verification.":view.replacementAllowed?"Your card was declined. You may enter another card for this same payment.":"Your original payment needs a status check before continuing."}</p>}
    {message&&<p role="alert">{message}</p>}
    {!terminal&&<div className="flex flex-wrap gap-3">
      {props.allowNewPayment!==false&&<button disabled={busy||!ready} onClick={()=>void pay()} className="rounded-lg border px-4 py-2">{hasSaved?"Retry saved payment":"Pay "+money(props.amountCents)}</button>}
      {props.allowNewPayment!==false&&view?.replacementAllowed===true&&<button disabled={busy||!ready} onClick={()=>void pay(true)} className="rounded-lg border px-4 py-2">Use replacement card</button>}
      {view?.paymentStatus==="requires_action"&&<button disabled={busy||!ready} onClick={()=>void authenticate()} className="rounded-lg border px-4 py-2">Verify with your bank</button>}
      {view?.paymentStatus==="requires_confirmation"&&<button disabled={busy} onClick={()=>void afterAuthentication()} className="rounded-lg border px-4 py-2">Continue after bank verification</button>}
      <button disabled={busy} onClick={()=>void run(async()=>{await action({kind:"observe"});})} className="rounded-lg border px-4 py-2">Check payment status</button>
      <button disabled={busy} onClick={()=>void run(async()=>{
        if(props.mode==="monthly_payoff"){
          if(!window.confirm("Stop this unpaid payoff? Your existing membership terms remain in place."))return;
          await action({kind:"stop",confirmed:true});
        }else await action({kind:"stop"});
      })} className="rounded-lg border px-4 py-2">{props.mode==="monthly_payoff"?"Stop unpaid payoff":"Stop unpaid payment"}</button>
    </div>}
    {busy&&<p role="status">Checking your original payment…</p>}
  </section>;
}
