"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PaymentDetailSkeleton, PaymentReviewBodySkeleton } from "@/components/loading/Skeletons";
import { useSearchParams } from "next/navigation";
import { PURCHASE_POLICY_VERSION } from "@/lib/purchasePolicies";
import type { ProductPurchaseTerms } from "@/lib/purchaseConsent";
import type { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { FIXED_PURCHASE_CONSENT_TEXT } from "@/lib/installments/purchaseConsent";
import dynamic from "next/dynamic";
const ManualMentorshipPayment=dynamic(()=>import("@/components/ManualMentorshipPayment"),{ssr:false});
type InstallmentQuote=ReturnType<typeof mentorshipInstallmentQuote>;
type ReviewOffer=(ProductPurchaseTerms|InstallmentQuote) & {installmentChoices?:InstallmentQuote[];manualCheckoutEnabled?:boolean};
type SavedSelection={manual?:boolean;request:{request_id:string;product_id:string;post_id:string;payment_count:number;acceptance:{accepted:true;version:string;fingerprint:string}};quote:InstallmentQuote};
type FullSelection={manualRequestId?:string;attemptId?:string;quote:ProductPurchaseTerms;request:{type:"product";product_id:string;post_id?:string;purchase_consent:{accepted:true;version:string;fingerprint:string}}};
const fullRecoveryHref=(productId:string,attemptId?:string)=>`/purchase/review?${new URLSearchParams({product_id:productId,full_recovery:"1",...(attemptId?{full_attempt_id:attemptId}:{})})}`;

function FullCheckoutRecovery({productId,originalAttemptId}:{productId:string;originalAttemptId:string}) {
  const [revision,setRevision]=useState(0),[canRecover,setCanRecover]=useState(false),[loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [canStop,setCanStop]=useState(false),[released,setReleased]=useState(false),[attemptId,setAttemptId]=useState(originalAttemptId);
  const lock=useRef(false),mounted=useRef(true),attemptRef=useRef(originalAttemptId);
  function applyView(body:any,expectedAttemptId:string){
    if(body.productId!==productId||body.accessGranted!==false||typeof body.attemptId!=="string"||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.attemptId)||
      expectedAttemptId&&body.attemptId!==expectedAttemptId)throw Error();
    if(body.status==="released"){
      if(!expectedAttemptId||body.canSwitchPaymentMode!==true||body.canRecover!==false||body.canStopUnpaid!==false||
        typeof body.releasedAt!=="string"||!Number.isFinite(Date.parse(body.releasedAt))||Date.parse(body.releasedAt)>Date.now()+5000||
        typeof body.buyerId!=="string"||!body.buyerId||typeof body.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(body.fingerprint))throw Error();
      try{
        const key=fullStorageKey({terms:{buyerId:body.buyerId,productId}}),raw=localStorage.getItem(key),saved=raw?JSON.parse(raw):null;
        // Same-price/newer selections must survive an old release readback.
        if(saved?.attemptId===body.attemptId&&saved.quote?.fingerprint===body.fingerprint&&saved.quote?.terms?.buyerId===body.buyerId&&
          saved.request?.product_id===productId&&localStorage.getItem(key)===raw)localStorage.removeItem(key);
      }catch{/* Original release remains readable without browser storage. */}
      setReleased(true);setCanRecover(false);setCanStop(false);setMessage("");
    }else{
      if(body.status!=="saved_checkout"||typeof body.canRecover!=="boolean"||body.canSwitchPaymentMode!==false)throw Error();
      if(body.canStopUnpaid===true){
        if(typeof body.buyerId!=="string"||!body.buyerId||typeof body.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(body.fingerprint))throw Error();
        try{
          const key=fullStorageKey({terms:{buyerId:body.buyerId,productId}}),raw=localStorage.getItem(key),saved=raw?JSON.parse(raw):null;
          if(saved?.quote?.fingerprint===body.fingerprint&&saved.quote?.terms?.buyerId===body.buyerId&&saved.request?.product_id===productId&&
            (!saved.attemptId||saved.attemptId===body.attemptId)&&localStorage.getItem(key)===raw)
            localStorage.setItem(key,JSON.stringify({...saved,attemptId:body.attemptId}));
        }catch{/* Provider/database ownership controls stopping, not storage. */}
      }
      setReleased(false);setCanRecover(body.canRecover);setCanStop(body.canStopUnpaid===true);
      if(!body.canRecover&&!body.canStopUnpaid)setMessage("Recovery is unavailable. Contact support before starting another payment.");
    }
    attemptRef.current=body.attemptId;setAttemptId(body.attemptId);
  }
  const readUrl=(id:string)=>`/api/checkout/recover?${new URLSearchParams({product_id:productId,...(id?{attempt_id:id}:{})})}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setCanRecover(false);setCanStop(false);setMessage("");
    const expected=attemptRef.current;
    void fetch(readUrl(expected),{credentials:"include",cache:"no-store",signal:controller.signal})
      .then(async response=>{
        const body=await response.json();
        if(!response.ok)throw Error(body.error||"Your original checkout needs review.");
        if(!controller.signal.aborted)applyView(body,expected);
      }).catch(()=>{if(!controller.signal.aborted)setMessage("Your original checkout could not be verified. Contact support before starting another payment.");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[productId,revision]);
  async function stop(){
    if(lock.current||busy||!canStop||!attemptId||released)return;
    const original=attemptId;lock.current=true;setBusy(true);setCanStop(false);setCanRecover(false);setMessage("");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try{
      // Ignore the action reply, including a success claim. Only a readback of
      // this exact original attempt can unlock a fresh payment selection.
      try{await fetch("/api/checkout/stop",{method:"POST",credentials:"include",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json"},body:JSON.stringify({attemptId:original})});}catch{/* Recover committed stop below. */}
      const response=await fetch(readUrl(original),{credentials:"include",cache:"no-store",signal:controller.signal}),body=await response.json();
      if(!response.ok)throw Error();if(!mounted.current)return;applyView(body,original);
      if(body.status!=="released")setMessage("Stopping this checkout still needs confirmation. Keep the original selection locked and check recovery availability.");
    }catch{if(mounted.current)setMessage("Stopping this checkout still needs confirmation. Check recovery availability before choosing another payment mode.");}
    finally{clearTimeout(timer);lock.current=false;if(mounted.current)setBusy(false);}
  }
  async function recover(){
    if(lock.current||busy||!canRecover)return;
    lock.current=true;setBusy(true);setMessage("");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try{
      const response=await fetch("/api/checkout/recover",{method:"POST",credentials:"include",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json"},body:JSON.stringify({productId,attemptId})});
      const body=await response.json();
      if(!response.ok||body.productId!==productId||body.attemptId!==attemptId||body.accessGranted!==false||body.canSwitchPaymentMode!==false||
        typeof body.sessionId!=="string"||!body.sessionId.startsWith("cs_"))throw Error();
      if(!mounted.current)return;
      if(body.status==="reconciliation_required"){
        setMessage("Your original checkout needs payment reconciliation. This is not a receipt or permission to start another payment.");return;
      }
      if(body.status!=="checkout_open"||typeof body.url!=="string")throw Error();
      const url=new URL(body.url);
      if(url.protocol!=="https:"||url.hostname!=="checkout.stripe.com"||url.username||url.password||url.port)throw Error();
      window.location.assign(url.toString());
    }catch{if(mounted.current)setMessage("Recovery is not confirmed. Your original checkout remains saved. Retry recovery or contact support before starting another payment.");}
    finally{clearTimeout(timer);lock.current=false;if(mounted.current)setBusy(false);}
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="underline">Back to CreatorNet</Link>
    <h1 className="text-2xl font-semibold">Recover your original full-payment checkout</h1>
    <p>Your original payment selection stays locked while recovery is unresolved. Recovery uses the saved checkout and its original terms. This is not a payment receipt.</p>
    {loading&&<p role="status">Checking your saved checkout...</p>}
    {message&&<p role="alert">{message}</p>}
    {attemptId&&<Link className="block underline" href={fullRecoveryHref(productId,attemptId)}>Open this original checkout recovery</Link>}
    {canRecover&&<button disabled={busy||loading} onClick={()=>void recover()} className="rounded-lg border px-4 py-2">{busy?"Recovering checkout...":"Recover original checkout"}</button>}
    {canStop&&!released&&<><p>Stop this unpaid checkout before choosing another payment option. Any recorded payment needs separate reconciliation.</p>
      <button disabled={busy||loading} onClick={()=>void stop()} className="rounded-lg border px-4 py-2">Stop original unpaid checkout</button></>}
    {released&&<><p role="status">Your original unpaid checkout was stopped and its selection released. Review the current offer and give new consent before another payment.</p>
      <Link className="block underline" href={`/purchase/review?${new URLSearchParams({product_id:productId})}`}>Review current offer and choose payment mode</Link></>}
    <button disabled={busy||loading} onClick={()=>setRevision(value=>value+1)} className="rounded-lg border px-4 py-2">Check recovery availability</button>
    <p>Questions? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
const fullStorageKey=(q:OfferScope)=>`creatornet:mentorship-full-selection:${q.terms.buyerId}:${q.terms.productId}`;
function readFullSelection(q:OfferScope):FullSelection|null {
  const raw=localStorage.getItem(fullStorageKey(q));if(!raw)return null;
  const saved=JSON.parse(raw) as FullSelection,t=saved?.quote?.terms,r=saved?.request;
  if(!t || !r || t.buyerId!==q.terms.buyerId || t.productId!==q.terms.productId || t.kind!=="one_time" ||
    r.type!=="product" || r.product_id!==t.productId || (r.post_id??null)!==t.postId ||
    r.purchase_consent?.accepted!==true || r.purchase_consent.version!==t.version || r.purchase_consent.fingerprint!==saved.quote.fingerprint ||
    !Number.isSafeInteger(t.amountCents) || t.amountCents<50 || [t.title,t.description,t.billing,t.version,t.policy?.delivery,t.policy?.refunds,t.policy?.eligibility,t.policy?.refundFees].some(value=>typeof value!=="string") || (t.serviceDescription!==undefined && typeof t.serviceDescription!=="string"))
    throw Error("Your original full-payment selection needs review before changing payment mode.");
  return saved;
}
const money=(c:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(c/100);
type OfferScope={terms:{buyerId:string;productId:string}};
const storageKey=(q:OfferScope)=>`creatornet:mentorship-selection:${q.terms.buyerId}:${q.terms.productId}`;
function validateSelection(saved:SavedSelection,q:OfferScope):SavedSelection {
  const r=saved?.request,t=saved?.quote?.terms;
  if(!r || !t || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.request_id) ||
    r.product_id!==q.terms.productId || t.buyerId!==q.terms.buyerId || t.productId!==r.product_id || t.postId!==r.post_id ||
    t.paymentCount!==r.payment_count || r.acceptance?.accepted!==true || r.acceptance.version!==t.version ||
    r.acceptance.fingerprint!==saved.quote.fingerprint || t.kind!=="fixed_total_installments" ||
    !Number.isSafeInteger(t.amountCents) || t.amountCents<100 || !Number.isInteger(t.paymentCount) || t.paymentCount<2 || t.paymentCount>24 ||
    !Array.isArray(t.payments) || t.payments.length!==t.paymentCount || t.payments.some((payment,index)=>payment.number!==index+1 || !Number.isSafeInteger(payment.amountCents) || payment.amountCents<50) ||
    t.payments.reduce((sum,payment)=>sum+payment.amountCents,0)!==t.amountCents ||
    [t.title,t.description,t.billing,t.version,t.policy?.delivery,t.policy?.refunds,t.policy?.eligibility,t.policy?.refundFees].some(value=>typeof value!=="string") ||
    (t.serviceDescription!==undefined && typeof t.serviceDescription!=="string"))throw Error("Your saved selection needs review. Contact support before starting another purchase.");
  return saved;
}
function readSelection(q:OfferScope):SavedSelection|null {
  const raw=localStorage.getItem(storageKey(q));return raw?validateSelection(JSON.parse(raw),q):null;
}
function recoveredSelection(body:any,requestId:string,productId:string):SavedSelection {
  if(body?.requestId!==requestId || body.status!=="reserved" || body.providerOperationsAllowed!==false ||
    typeof body.fingerprint!=="string" || !/^[a-f0-9]{64}$/.test(body.fingerprint) || !body.terms ||
    (productId && body.terms.productId!==productId))throw Error("Your original selection could not be verified.");
  return validateSelection({quote:{terms:body.terms,fingerprint:body.fingerprint},request:{request_id:requestId,
    product_id:body.terms.productId,post_id:body.terms.postId,payment_count:body.terms.paymentCount,
    acceptance:{accepted:true,version:body.terms.version,fingerprint:body.fingerprint}}},body);
}

function confirmedRelease(body:any,original:SavedSelection):string|null {
  if(body.releasedAt==null)return null;
  const at=body.releasedAt;
  if(typeof at!=="string" || !Number.isFinite(Date.parse(at)) || Date.parse(at)<=0 || Date.parse(at)>Date.now()+5000)
    throw Error("Your original selection release could not be verified.");
  // Only a verified server response reaches this helper. Local storage cannot
  // authorize release, and a different/newer pending request must survive.
  try {
    const key=storageKey(original.quote),raw=localStorage.getItem(key),saved=raw?JSON.parse(raw):null;
    if(saved?.request?.request_id===original.request.request_id && saved.request.product_id===original.request.product_id &&
      saved.quote?.fingerprint===original.quote.fingerprint && saved.quote?.terms?.buyerId===original.quote.terms.buyerId)
      localStorage.removeItem(key);
  }catch {/* Historical recovery remains readable without browser storage. */}
  return at;
}

function Review() {
  const search = useSearchParams();
  const productId = search.get("product_id") || "", postId = search.get("post_id") || "",requestId=search.get("request_id")||"";
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([productId, postId, requestId, revision]);
  const [loaded, setLoaded] = useState<{ key: string; quote?: ReviewOffer; error?: string } | null>(null);
  const [fullSelection,setFullSelection]=useState<FullSelection|null>(null);
  const [releasedAt,setReleasedAt]=useState<string|null>(null),[canAbandon,setCanAbandon]=useState(false);
  const [count,setCount]=useState(1),[selection,setSelection]=useState<SavedSelection|null>(null),[selectionConfirmed,setSelectionConfirmed]=useState(false);
  const lock=useRef(false),activeKey=useRef(key);activeKey.current=key;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ product_id: productId });
    if (postId) query.set("post_id", postId);
    if(requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      setLoaded({key,error:"Invalid saved selection link."});return ()=>controller.abort();
    }
    const endpoint=requestId?`/api/installments/reservations/${requestId}`:"/api/purchase-consent?"+query;
    void fetch(endpoint, { credentials: "include", cache:"no-store", signal: controller.signal })
      .then(async response => {
        let body = await response.json(),recoveryId=requestId;
        if(!requestId && response.status===404 && !controller.signal.aborted) {
          const recovery=await fetch(`/api/installments/reservations?${new URLSearchParams({product_id:productId})}`,{credentials:"include",cache:"no-store",signal:controller.signal});
          if(recovery.ok){body=await recovery.json();if(typeof body?.requestId!=="string" || !body.requestId)throw Error("Your original selection could not be verified.");response=recovery;recoveryId=body.requestId;}
        }
        if (!response.ok) throw Error(body.error || "Could not load the offer.");
        if (!controller.signal.aborted) {
          const saved=recoveryId?recoveredSelection(body,recoveryId,productId):readSelection(body);
          const full=recoveryId?null:readFullSelection(body);
          if(saved && full)throw Error("Existing payment selections need review before another checkout.");
          setReleasedAt(recoveryId&&saved?confirmedRelease(body,saved):null);
          setCanAbandon(Boolean(recoveryId&&body.canAbandonUnpaid===true&&!body.releasedAt));
          setFullSelection(full);
          setLoaded({ key, quote: recoveryId?saved!.quote:body });setSelection(saved);setSelectionConfirmed(Boolean(recoveryId));setCount(saved?.request.payment_count??1);
          setAccepted(false);setPaymentError("");
        }
      }).catch(error => {
        if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Could not load the offer." });
      });
    return () => controller.abort();
  }, [productId, postId, requestId, key]);
  const current = loaded?.key === key ? loaded : null;
  const offer=current?.quote;
  const installment=selection?.quote??offer?.installmentChoices?.find(choice=>choice.terms.paymentCount===count);
  const quote=count===1?(fullSelection?.quote??offer):installment;
  async function saveSelection(recover=false) {
    if(lock.current || !offer || !installment || (!recover && !accepted))return;
    lock.current=true;setBusy(true);setPaymentError("");setAccepted(false);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try {
      if(!selectionConfirmed && readFullSelection(offer))throw Error("Recover your original full-payment checkout before changing payment mode.");
      let original=selection??readSelection(offer);
      if(!original) {
        if(recover || !installment.terms.postId)throw Error("Review the original offer before continuing.");
        original={...(offer.manualCheckoutEnabled?{manual:true}:{}),quote:installment,request:{request_id:crypto.randomUUID(),product_id:installment.terms.productId,post_id:installment.terms.postId,
          payment_count:installment.terms.paymentCount,acceptance:{accepted:true,version:installment.terms.version,fingerprint:installment.fingerprint}}};
        const serialized=JSON.stringify(original);localStorage.setItem(storageKey(offer),serialized);
        if(localStorage.getItem(storageKey(offer))!==serialized)throw Error("Could not save your original selection. No request was sent.");
      }
      setSelection(original);setCount(original.request.payment_count);
      // GET first after uncertainty. Never replace the original acceptance with
      // the newly loaded catalog or use the generic installment checkout route.
      let response=recover?await fetch(`/api/installments/reservations/${original.request.request_id}`,{credentials:"include",cache:"no-store",signal:controller.signal}):null;
      if(!response || response.status===404 && !selectionConfirmed)response=await fetch("/api/installments/reservations",{method:"POST",credentials:"include",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json"},body:JSON.stringify(original.request)});
      const body=await response.json();
      if(!response.ok || body.requestId!==original.request.request_id || body.status!=="reserved" || body.fingerprint!==original.quote.fingerprint ||
        body.terms?.buyerId!==offer.terms.buyerId || body.terms.productId!==original.request.product_id || body.terms.postId!==original.request.post_id ||
        body.terms.paymentCount!==original.request.payment_count || body.providerOperationsAllowed!==false)throw Error("Your selection is not confirmed. Recover the saved selection before changing payment mode.");
      if(activeKey.current===key){setReleasedAt(confirmedRelease(body,original));setCanAbandon(body.canAbandonUnpaid===true&&!body.releasedAt);setSelectionConfirmed(true);}
    } catch(error) {if(activeKey.current===key)setPaymentError(error instanceof Error?error.message:"Your saved selection needs review.");}
    finally {clearTimeout(timer);lock.current=false;if(activeKey.current===key)setBusy(false);}
  }
  async function abandonSelection() {
    if(lock.current || busy || !selection || !selectionConfirmed || !canAbandon || releasedAt)return;
    lock.current=true;setBusy(true);setAccepted(false);setPaymentError("");setCanAbandon(false);
    const original=selection,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try{
      // A response may be lost after the stop committed. Always recover the same
      // request; never unlock mode choice from the POST reply or a redirect.
      try {await fetch(`/api/installments/reservations/${original.request.request_id}`,{method:"POST",credentials:"include",cache:"no-store",
        signal:controller.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"abandon_unpaid"})});}catch{/* Read original status below. */}
      const response=await fetch(`/api/installments/reservations/${original.request.request_id}`,{credentials:"include",cache:"no-store",signal:controller.signal});
      const body=await response.json();
      if(!response.ok)throw Error();
      const saved=recoveredSelection(body,original.request.request_id,original.request.product_id);
      if(saved.quote.fingerprint!==original.quote.fingerprint||saved.quote.terms.buyerId!==original.quote.terms.buyerId)throw Error();
      const at=confirmedRelease(body,original);if(!at)throw Error();
      if(activeKey.current===key){setReleasedAt(at);setSelectionConfirmed(true);}
    }catch{if(activeKey.current===key)setPaymentError("Stopping this checkout still needs confirmation. Recover the saved selection before choosing another payment mode.");}
    finally{clearTimeout(timer);lock.current=false;if(activeKey.current===key)setBusy(false);}
  }
  function reloadOffer() {
    setAccepted(false); setPaymentError(""); setRevision(value => value + 1);
  }
  async function checkout(coordinated=false) {
    if (!accepted || !quote || busy || lock.current || selection || fullSelection) return;
    if(offer?.manualCheckoutEnabled&&!coordinated){
      if(!navigator.locks){setPaymentError("Use a browser that supports secure checkout coordination.");return;}
      await navigator.locks.request(`creatornet-selection:${offer.terms.buyerId}:${offer.terms.productId}`,()=>checkout(true));return;
    }
    if(count!==1){await saveSelection();return;}
    lock.current=true;
    setBusy(true); setPaymentError("");
    try {
      if(offer && readSelection(offer))throw Error("Recover your saved installment selection before starting another purchase.");
      let original=offer?readFullSelection(offer):null;
      if(original){setFullSelection(original);throw Error("Recover your original full-payment checkout before starting another payment.");}
      const request:FullSelection["request"]={type:"product",product_id:quote.terms.productId,post_id:quote.terms.postId??undefined,
        purchase_consent:{accepted:true,version:PURCHASE_POLICY_VERSION,fingerprint:quote.fingerprint}};
      if(offer?.manualCheckoutEnabled){
        if(quote.terms.kind!=="one_time"||!request.post_id)throw Error("Review the original full-payment offer.");
        const manual:FullSelection={manualRequestId:crypto.randomUUID(),quote:quote as ProductPurchaseTerms,request};
        const raw=JSON.stringify(manual);localStorage.setItem(fullStorageKey(offer),raw);
        if(localStorage.getItem(fullStorageKey(offer))!==raw)throw Error("Could not save your original selection. No request was sent.");
        setFullSelection(manual);await acceptManualFull(manual);setBusy(false);return;
      }
      if(!original && offer?.installmentChoices?.length) {
        if(quote.terms.kind!=="one_time")throw Error("Review the original full-payment terms.");
        original={quote:quote as ProductPurchaseTerms,request};
        const serialized=JSON.stringify(original);localStorage.setItem(fullStorageKey(offer),serialized);
        if(localStorage.getItem(fullStorageKey(offer))!==serialized)throw Error("Could not save the original checkout request. No request was sent.");
      }
      if(original)setFullSelection(original);
      const response = await fetch("/api/checkout", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(original?.request??request),
      });
      const body = await response.json();
      if (!response.ok || body.requires_consent || typeof body.url !== "string") throw Error(body.error || "Review the current offer before continuing.");
      const url = new URL(body.url);
      if (url.protocol !== "https:" && !(url.origin === window.location.origin && url.protocol === "http:")) throw Error("Invalid checkout destination.");
      window.location.assign(url.toString());
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : "Checkout could not be started."); setBusy(false);
    } finally {lock.current=false;}
  }
  async function acceptManualFull(original:FullSelection){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
    try{
    const response=await fetch("/api/checkout/manual",{method:"POST",credentials:"include",cache:"no-store",signal:controller.signal,
      headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:original.manualRequestId,
        product_id:original.request.product_id,post_id:original.request.post_id,acceptance:original.request.purchase_consent})});
    const body=await response.json();
    if(!response.ok||body.requestId!==original.manualRequestId||body.fingerprint!==original.quote.fingerprint||
      body.buyerId!==original.quote.terms.buyerId||body.productId!==original.request.product_id||body.status!=="saved_selection")
      throw Error("Your original payment selection needs recovery before payment.");
    }finally{clearTimeout(timer);}
  }
  function releaseManualFull(original:FullSelection,releasedAt:string){
    const key=fullStorageKey(original.quote),raw=localStorage.getItem(key),saved=raw?JSON.parse(raw):null;
    if(saved?.manualRequestId===original.manualRequestId&&localStorage.getItem(key)===raw)localStorage.removeItem(key);
    setReleasedAt(releasedAt);
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="text-sm underline">Back to CreatorNet</Link>
    <h1 className="text-2xl font-semibold">Review your purchase</h1>
    {productId&&!requestId&&<details className="rounded-lg border p-4"><summary>Already started a payment?</summary>
      <p>Recover the original payment before starting another checkout, even if this device no longer has its saved selection.</p>
      <Link className="block underline" href={`/purchase/manual?${new URLSearchParams({product_id:productId,mode:"full"})}`}>Find saved full payment</Link>
      <Link className="block underline" href={`/purchase/manual?${new URLSearchParams({product_id:productId,mode:"installments"})}`}>Find saved installment payment</Link>
      <Link className="block underline" href={fullRecoveryHref(productId)}>Recover earlier hosted checkout</Link>
    </details>}
    {!current ? <PaymentReviewBodySkeleton label="Loading the current offer…" /> : current.error ? <>
      <p role="alert">{current.error}</p>
      <button onClick={reloadOffer} className="rounded-lg border px-4 py-2">Reload offer</button>
      {productId&&!requestId&&<Link className="block underline" href={fullRecoveryHref(productId)}>Recover original full-payment checkout</Link>}
    </> : quote && <>
      {offer?.installmentChoices?.length && !selection && !fullSelection ? <fieldset className="space-y-3 rounded-xl border p-4" disabled={busy}>
        <legend className="px-2 font-semibold">Choose how to pay</legend>
        <label className="flex gap-3"><input type="radio" name="payment-choice" checked={count===1} onChange={()=>{setCount(1);setAccepted(false);setPaymentError("");}}/>Pay in full: {money(offer.terms.amountCents)}</label>
        {offer.installmentChoices.map(choice=><label className="flex gap-3" key={choice.terms.paymentCount}><input type="radio" name="payment-choice" checked={count===choice.terms.paymentCount}
          onChange={()=>{setCount(choice.terms.paymentCount);setAccepted(false);setPaymentError("");}}/>{choice.terms.paymentCount} monthly payments, {money(choice.terms.payments[0].amountCents)} first</label>)}
      </fieldset>:null}
      {fullSelection && !fullSelection.manualRequestId && <><p role="status">Your original full-payment checkout is saved. Recover that same checkout or contact support before changing payment mode. This is not a payment receipt.</p>
        <Link className="block underline" href={fullRecoveryHref(fullSelection.request.product_id,fullSelection.attemptId)}>Recover original full-payment checkout</Link></>}
      {selection && <section className="space-y-3 rounded-xl border p-4" aria-label="Saved installment selection">
        <p role="status">{releasedAt?"This installment selection was released after its unpaid checkout was stopped. The original terms remain here for your records.":selectionConfirmed?"Your installment selection is saved. This is not a payment receipt.":"An installment selection is saved on this device. Recover its status before starting another purchase."}</p>
        <Link className="block underline" href={selection.manual?`/purchase/manual?mode=installments&request_id=${selection.request.request_id}`:`/purchase/review?request_id=${selection.request.request_id}`}>Open original selection recovery</Link>
        <button disabled={busy} onClick={()=>void saveSelection(true)} className="rounded-lg border px-4 py-2">Recover saved selection</button>
        {selectionConfirmed && canAbandon && !releasedAt && !selection.manual && <>
          <p>Stop this unpaid checkout before choosing a different payment option. Payments already made and any agreed balance need separate review.</p>
          <button disabled={busy} onClick={()=>void abandonSelection()} className="rounded-lg border px-4 py-2">Stop unpaid checkout</button>
        </>}
        {releasedAt && <Link className="block underline" href={`/purchase/review?${new URLSearchParams({product_id:selection.request.product_id,post_id:selection.request.post_id})}`}>Review current offer and choose payment mode</Link>}
        {selectionConfirmed && !releasedAt && <Link className="block underline" href={`/payments/mentorship/${selection.request.request_id}`}>View saved payment plan</Link>}
      </section>}
      {fullSelection?.manualRequestId&&<Link className="block underline" href={`/purchase/manual?mode=full&request_id=${fullSelection.manualRequestId}`}>Recover original full payment</Link>}
      {fullSelection?.manualRequestId&&!releasedAt&&<ManualMentorshipPayment key={fullSelection.manualRequestId}
        requestId={fullSelection.manualRequestId} buyerId={fullSelection.quote.terms.buyerId} productId={fullSelection.request.product_id}
        mode="full" amountCents={fullSelection.quote.terms.amountCents} ensureSelection={()=>acceptManualFull(fullSelection)}
        onReleased={at=>releaseManualFull(fullSelection,at)}/>}
      {fullSelection?.manualRequestId&&releasedAt&&<Link className="block underline" href={`/purchase/review?${new URLSearchParams({product_id:fullSelection.request.product_id,post_id:fullSelection.request.post_id!})}`}>Review current offer and choose payment mode</Link>}
      {selection?.manual&&selectionConfirmed&&!releasedAt&&<ManualMentorshipPayment key={selection.request.request_id}
        requestId={selection.request.request_id} buyerId={selection.quote.terms.buyerId} productId={selection.request.product_id}
        mode="installments" amountCents={selection.quote.terms.payments[0].amountCents} onReleased={at=>{
          confirmedRelease({releasedAt:at},selection);setReleasedAt(at);
        }}/>}
      <section className="space-y-3 rounded-xl border border-gray-500 p-5">
        <h2 className="text-xl font-semibold">{quote.terms.title}</h2>
        <p className="text-xl">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(quote.terms.amountCents / 100)}</p>
        <p>{quote.terms.billing}</p>
        {count!==1 && installment && <ul aria-label="Installment schedule">{installment.terms.payments.map(payment=><li key={payment.number}>
          Payment {payment.number}: {money(payment.amountCents)} {payment.number===1?"at checkout":`${payment.number-1} calendar month${payment.number===2?"":"s"} after the first payment`}
        </li>)}</ul>}
        {quote.terms.serviceDescription && <p>{quote.terms.serviceDescription}</p>}
        {quote.terms.description && <p className="whitespace-pre-wrap">{quote.terms.description}</p>}
        <p>{quote.terms.policy.delivery}</p>
      </section>
      <section className="space-y-3 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold">Refunds and service terms</h2>
        <p>{quote.terms.policy.refunds}</p><p>{quote.terms.policy.eligibility}</p>
        {quote.terms.kind === "paid_call" && <p>{quote.terms.policy.calls}</p>}
        <p>{quote.terms.policy.refundFees}</p>
        <p><Link href="/legal/purchase-agreement" target="_blank" rel="noopener noreferrer" className="underline">Complete purchase agreement ({quote.terms.version})</Link></p>
      </section>
      <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
        <input type="checkbox" checked={accepted} disabled={busy||Boolean(selection)||Boolean(fullSelection)} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
        <span>{count===1?"I agree to the displayed offer, its price, delivery and refund rules, and the linked purchase agreement. This is not consent to an automatic monthly membership or an early-exit payoff.":FIXED_PURCHASE_CONSENT_TEXT}</span>
      </label>
      {paymentError && <>
        <p role="alert">{paymentError}</p>
        <button onClick={reloadOffer} disabled={busy} className="rounded-lg border px-4 py-2">Review current offer</button>
      </>}
      <button disabled={!accepted || busy || Boolean(selection)||Boolean(fullSelection)} onClick={() => void checkout()} className="rounded-lg bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">{busy ? "Opening checkout..." : count===1||offer?.manualCheckoutEnabled?"Agree and continue to payment":"Agree and save installment selection"}</button>
    </>}
    <p className="text-sm">Questions? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
function ReviewRoute(){
  const search=useSearchParams(),productId=search.get("product_id")||"";
  const originalAttemptId=search.get("full_attempt_id")||"";
  return search.get("full_recovery")==="1"?<FullCheckoutRecovery key={`${productId}:${originalAttemptId}`} productId={productId} originalAttemptId={originalAttemptId}/>:<Review/>;
}
export default function PurchaseReviewPage() { return <Suspense fallback={<PaymentDetailSkeleton label="Loading your purchase…" />}><ReviewRoute /></Suspense>; }
