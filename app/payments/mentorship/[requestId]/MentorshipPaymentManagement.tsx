"use client";
import {useEffect,useRef,useState} from "react";
import {completeContextBankVerification} from "@/lib/installments/bankVerificationClient";
import {CARD_SETUP_CONSENT_TEXT,CARD_SETUP_CONSENT_VERSION,PAY_NOW_CONSENT_VERSION,FUTURE_CARD_CONSENT_TEXT,FUTURE_CARD_CONSENT_VERSION,retryConsentText} from "@/lib/installments/buyerRecoveryView";
import type {BuyerMentorshipManagementView} from "@/lib/mentorshipInstallmentManagement";
const money=(c:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(c/100);
const button="min-h-11 rounded-xl border border-white/20 px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-40";
const labels:Record<string,string>={scheduled:"Scheduled",paid_accounted:"Payment recorded",action_required:"Bank verification needed",
  payment_method_required:"Payment method needs attention",payment_pending:"Payment being checked",terminal_unpaid:"Support review needed",review_required:"Support review needed"};
const paidMessage=(future:unknown)=>"Your installment payment has been verified and recorded. "+
  (future==="collection_resumed"?"Future installments will use your replacement card on the agreed schedule. Refresh records for the current plan status.":
    "Future automatic collection remains under review. Refresh records or contact support about the remaining schedule.");
export function MentorshipPaymentManagement({initial}:{initial:BuyerMentorshipManagementView}) {
  const [view,setView]=useState(initial),[accepted,setAccepted]=useState<number|null>(null),[busy,setBusy]=useState(false),
    [uncertain,setUncertain]=useState(false),[message,setMessage]=useState(""),[stopAccepted,setStopAccepted]=useState(false),[cardAccepted,setCardAccepted]=useState<number|null>(null);
  const [payAccepted,setPayAccepted]=useState<string|null>(null),[attempted,setAttempted]=useState<string[]>([]),[futureAccepted,setFutureAccepted]=useState<string|null>(null);
  const lock=useRef(false),controller=useRef<AbortController|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;
    try {setAttempted(initial.payments.flatMap(p=>{const id=localStorage.getItem(`creatornet:mentorship-quote:${initial.requestId}:${p.invoiceId}:attempted`);return id?[id]:[];}));} catch { /* POST also requires durable storage before dispatch. */ }
return ()=>{mounted.current=false;controller.current?.abort();};},[]);
  const endpoint=`/api/installments/reservations/${encodeURIComponent(view.requestId)}`;
  async function retryAction(p:BuyerMentorshipManagementView["payments"][number],pay:boolean) {
    const review=p.retry,setupId=p.cardSetup?.requestId;
    if(lock.current || !p.invoiceId || !setupId || !review || view.debitStopped || view.financialReview || uncertain ||
      (pay? !review.canPay || !review.quote || payAccepted!==review.quote.id:!review.canReview))return;
    const consentFuture=pay && Boolean(review.quote?.remainingPayments) && review.canUseFutureCard && futureAccepted===review.quote?.id;
    lock.current=true;setBusy(true);setPayAccepted(null);setFutureAccepted(null);setAccepted(null);
    const c=new AbortController();controller.current=c;const timer=setTimeout(()=>c.abort(),65000);
    const key=`creatornet:mentorship-quote:${view.requestId}:${p.invoiceId}`;
    try {
      let quoteId=review.quote?.id, futureCardOption=false;
      if(pay) {
        if(!quoteId || review.quote!.expiresAt<=Date.now()/1000 || attempted.includes(quoteId) || localStorage.getItem(`${key}:attempted`)===quoteId)throw Error();
        localStorage.setItem(`${key}:attempted`,quoteId);if(localStorage.getItem(`${key}:attempted`)!==quoteId)throw Error();
        setAttempted(old=>[...old,quoteId!]);
      } else {
        // Reuse an uncertain review ID. A new review is allowed only after the
        // server returned the old quote and its immutable window has expired.
        const expired=review.quote && review.quote.expiresAt<=Date.now()/1000;
        const saved=localStorage.getItem(`${key}:request`);
        const original=saved?JSON.parse(saved):null;
        if(original && (typeof original.quoteId!=="string" || typeof original.futureCardOption!=="boolean"))throw Error();
        if(review.quote && !expired) {
          quoteId=review.quote.id;futureCardOption=Boolean(review.quote.remainingPayments);
        } else if(!expired && original) {
          quoteId=original.quoteId;futureCardOption=original.futureCardOption;
        } else {
          const legacy=expired?null:localStorage.getItem(key);
          quoteId=legacy??crypto.randomUUID();
          // Historical saved review IDs were created without the future option.
          futureCardOption=!legacy && review.canUseFutureCard && p.paymentNumber<view.paymentCount;
        }
        if(!quoteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quoteId))throw Error();
        const request=JSON.stringify({quoteId,futureCardOption});
        localStorage.setItem(`${key}:request`,request);if(localStorage.getItem(`${key}:request`)!==request)throw Error();
        localStorage.setItem(key,quoteId);if(localStorage.getItem(key)!==quoteId)throw Error();
      }
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",signal:c.signal,
        body:JSON.stringify({action:pay?"pay_retry":"review_retry",invoiceId:p.invoiceId,setupId,quoteId,
          ...(pay?{consent:{accepted:true,consentVersion:PAY_NOW_CONSENT_VERSION,
            ...(consentFuture?{futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION}:{})}}:{futureCardOption})})});
      if(!response.ok)throw Error();const result=await response.json();if(c.signal.aborted || !mounted.current)return;
      if(pay) {
        if(result.status!=="payment_recovery_recorded" || !Object.hasOwn(labels,result.outcome))throw Error();
        setUncertain(true);
        setView(current=>({...current,payments:current.payments.map(item=>item.paymentNumber===p.paymentNumber?
          {...item,outcome:result.outcome,canVerifyBank:false,retry:{...review,canPay:false,canReview:false}}:item)}));
        setMessage(result.outcome==="paid_accounted"?paidMessage(result.futureCollection):
          "The payment attempt needs follow-up. Refresh records, then check this payment or continue bank verification if offered.");
      } else {
        const q=result.quote;
        if(result.status!=="payment_review" || q?.id!==quoteId || q.amountCents!==p.amountCents || q.paymentNumber!==p.paymentNumber ||
          q.paymentCount!==view.paymentCount || q.consentVersion!==PAY_NOW_CONSENT_VERSION || q.confirmed!==false ||
          !Number.isSafeInteger(q.expiresAt) || q.futureCardAccepted!==undefined || Boolean(q.remainingPayments)!==futureCardOption)throw Error();
        if(futureCardOption && (!Array.isArray(q.remainingPayments) || q.remainingPayments.length!==view.paymentCount-p.paymentNumber ||
          q.remainingPayments.length===0 || q.remainingPayments.some((next:{paymentNumber:number;amountCents:number;dueAt:number;periodEnd:number},i:number)=>{
            const scheduled=view.payments.find(item=>item.paymentNumber===p.paymentNumber+i+1);
            return !scheduled || next.paymentNumber!==scheduled.paymentNumber || next.amountCents!==scheduled.amountCents || next.dueAt!==scheduled.dueAt ||
              !Number.isSafeInteger(next.periodEnd) || next.periodEnd<=next.dueAt || (i>0 && q.remainingPayments[i-1].periodEnd!==next.dueAt);
          })))throw Error();
        setView(current=>({...current,payments:current.payments.map(item=>item.paymentNumber===p.paymentNumber?
          {...item,retry:{...review,quote:q,canPay:q.expiresAt>Date.now()/1000}}:item)}));
        setMessage("Review the amount and consent below. No payment was attempted.");
      }
    } catch {if(mounted.current){if(pay)setUncertain(true);setMessage(pay?
      "The payment result is not confirmed. Refresh records and check the original payment; do not submit another payment request.":
      "The review is not confirmed. Refresh records or retry this same saved review.");}}
    finally {clearTimeout(timer);lock.current=false;if(mounted.current)setBusy(false);}
  }
  async function cardAction(p:BuyerMentorshipManagementView["payments"][number],action:"prepare_card"|"open_card"|"verify_card") {
    if(lock.current || !p.invoiceId || view.debitStopped || view.financialReview)return;
    if(action==="prepare_card" && (!(p.canStartCard||p.cardSetup?.canPrepare) || cardAccepted!==p.paymentNumber))return;
    if(action==="open_card" && !p.cardSetup?.canOpen || action==="verify_card" && !p.cardSetup?.canVerify)return;
    lock.current=true;setBusy(true);setCardAccepted(null);setAccepted(null);
    const c=new AbortController();controller.current=c;const timer=setTimeout(()=>c.abort(),65000);
    try {
      let setupId=p.cardSetup?.requestId;
      if(!setupId && action==="prepare_card") {
        const key=`creatornet:mentorship-card:${view.requestId}:${p.invoiceId}`;
        setupId=localStorage.getItem(key)??crypto.randomUUID();
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(setupId))throw Error();
        localStorage.setItem(key,setupId);if(localStorage.getItem(key)!==setupId)throw Error();
      }
      if(!setupId)throw Error();
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",signal:c.signal,
        body:JSON.stringify({action,invoiceId:p.invoiceId,setupId,...(action==="prepare_card"?{consent:{accepted:true,consentVersion:CARD_SETUP_CONSENT_VERSION}}:{})})});
      if(!response.ok)throw Error();const result=await response.json();
      if(result.setupId!==setupId || c.signal.aborted)throw Error();
      if(action==="open_card") {
        if(result.status!=="card_setup_ready" || typeof result.url!=="string")throw Error();
        const url=new URL(result.url);
        if(url.protocol!=="https:" || url.hostname!=="checkout.stripe.com" || url.username || url.password || url.port || !url.pathname.startsWith("/c/"))throw Error();
        window.location.assign(url.href);return;
      }
      if(action==="prepare_card" && result.status!=="prepared_unpublished" || action==="verify_card" &&
        !["setup_pending","card_saved_payment_not_attempted"].includes(result.status))throw Error();
      setView(current=>({...current,payments:current.payments.map(item=>item.paymentNumber===p.paymentNumber?{...item,canStartCard:false,
        cardSetup:{requestId:setupId!,state:result.status==="card_saved_payment_not_attempted"?"verified":"prepared",canPrepare:false,canOpen:false,canVerify:false}}:item)}));
      setMessage(result.status==="card_saved_payment_not_attempted"?"Your replacement card is saved. No payment was attempted and automatic billing has not restarted.":
        result.status==="setup_pending"?"Card setup is not complete. Refresh records to continue the same setup.":"Your original card setup is ready. Refresh records to open it securely.");
    } catch {if(mounted.current)setMessage("Card setup is not confirmed. Refresh records or retry the same saved request; do not start another purchase.");}
    finally {clearTimeout(timer);lock.current=false;if(mounted.current)setBusy(false);}
  }
  async function stopDebit() {
    if(lock.current || !view.canStopDebit || !stopAccepted)return;
    lock.current=true;setBusy(true);setStopAccepted(false);setAccepted(null);
    const c=new AbortController();controller.current=c;const timer=setTimeout(()=>c.abort(),65000);
    try {
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",
        signal:c.signal,body:JSON.stringify({action:"revoke_debit"})});
      if(!response.ok)throw Error();const result=await response.json();
      if(result.requestId!==view.requestId || !["admitted_payment_pending","new_debits_stopped"].includes(result.status) ||
        !Number.isInteger(result.pendingPayments) || result.pendingPayments<0 || result.pendingPayments>23 ||
        (result.status==="admitted_payment_pending")!==(result.pendingPayments>0) || !Number.isFinite(Date.parse(result.revokedAt)))throw Error();
      if(c.signal.aborted)return;
      setView(current=>({...current,debitStopped:true,canStopDebit:false,payments:current.payments.map(p=>({...p,canVerifyBank:false,canStartCard:false,
        ...(p.cardSetup?{cardSetup:{...p.cardSetup,canPrepare:false,canOpen:false,canVerify:false}}:{})}))}));
      setMessage(result.pendingPayments>0?"New automatic payments are stopped. A payment already in progress still needs confirmation. Your agreed unpaid balance remains due.":
        "New automatic payments are stopped. Your agreed unpaid balance remains due.");
    } catch {if(mounted.current){setUncertain(true);setMessage("The stop request is not confirmed. Refresh records, retry this same stop request, or contact support.");}}
    finally {clearTimeout(timer);lock.current=false;if(mounted.current){setBusy(false);if(c.signal.aborted){setUncertain(true);setMessage("The stop request timed out. Refresh records or retry this same stop request to confirm its status.");}}}
  }
  async function refresh() {
    if(lock.current)return;lock.current=true;setBusy(true);setAccepted(null);setCardAccepted(null);setPayAccepted(null);setFutureAccepted(null);
    const c=new AbortController();controller.current=c;const timer=setTimeout(()=>c.abort(),65000);
    try {
      const response=await fetch(`${endpoint}?view=payments`,{cache:"no-store",credentials:"same-origin",signal:c.signal});
      if(!response.ok)throw Error();const result=await response.json();
      if(result.view?.requestId!==view.requestId || result.view.mode!==view.mode || !Array.isArray(result.view.payments))throw Error();
      if(!c.signal.aborted){setView(result.view);setUncertain(false);setMessage("Payment records refreshed. No payment request was sent.");}
    } catch {if(mounted.current)setMessage("Records could not be refreshed. Check again or contact support.");}
    finally {clearTimeout(timer);lock.current=false;if(mounted.current)setBusy(false);}
  }
  async function bank(p:BuyerMentorshipManagementView["payments"][number],verify:boolean) {
    if(lock.current || !p.invoiceId || verify && (!p.canVerifyBank || accepted!==p.paymentNumber || uncertain) || !verify && !p.canCheck)return;
    lock.current=true;setBusy(true);setAccepted(null);setMessage(verify?"Opening secure bank verification…":"Checking the original payment receipt…");
    const c=new AbortController();controller.current=c;const timer=setTimeout(()=>c.abort(),65000);
    const post=async(action:string)=>{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",
        signal:c.signal,body:JSON.stringify({action,invoiceId:p.invoiceId})});
      if(!response.ok)throw Error();return response.json();
    };
    try {
      if(verify) {
        const capability=await post("bank_verification");
        if(capability.status!=="bank_verification_ready" || capability.amountCents!==p.amountCents || capability.paymentNumber!==p.paymentNumber)throw Error();
        if(c.signal.aborted)return;
        await completeContextBankVerification(capability.publishableKey,capability.clientSecret,view.mode);
      }
      if(c.signal.aborted)return;
      const result=await post("check_payment");
      if(result.status!=="payment_recovery_recorded" || !Object.hasOwn(labels,result.outcome))throw Error();
      if(c.signal.aborted)return;
      setUncertain(true);
      setView(current=>({...current,payments:current.payments.map(item=>item.paymentNumber===p.paymentNumber?
        {...item,outcome:result.outcome,canVerifyBank:false,canCheck:result.outcome!=="paid_accounted"}:item)}));
      setMessage(result.outcome==="paid_accounted"?paidMessage(result.futureCollection):
        "Payment is not yet verified. Refresh records or contact support before continuing.");
    } catch {if(mounted.current){setUncertain(true);setMessage("The payment result is not confirmed. Check the original receipt or contact support; do not start another purchase.");}}
    finally {clearTimeout(timer);lock.current=false;if(mounted.current){setBusy(false);if(c.signal.aborted){setUncertain(true);setMessage("The check timed out. Check the original receipt before continuing.");}}}
  }
  return <main className="mx-auto min-h-screen max-w-3xl px-5 py-12 text-white">
    <h1 className="text-3xl font-semibold">Your mentorship payments</h1><p className="mt-3 text-lg">{view.title}</p>
    <p className="mt-2 text-white/70">Agreed total: {money(view.totalCents)} across {view.paymentCount} payments.</p>
    <p className="mt-2 text-sm text-white/60">{view.serviceMonths===null?"Service duration follows your accepted terms.":`Your service lasts ${view.serviceMonths} months, independently of the payment schedule.`}</p>
    {view.serviceEndsAt!==null && <p className="mt-2 text-sm text-white/60">Service ends: {new Date(view.serviceEndsAt*1000).toLocaleDateString("en-US",{timeZone:"UTC",month:"long",day:"numeric",year:"numeric"})} (UTC).</p>}
    {view.financialReview && <p role="status" className="mt-5 rounded-xl border border-amber-300/40 p-4">A refund or dispute needs review. Contact support before taking further payment action.</p>}
    {view.debitStopped && <p className="mt-5">New automatic payments are stopped. Your agreed unpaid balance remains due.</p>}
    {view.collectionState && !view.debitStopped && !view.financialReview && <p className="mt-5" role="status">{
      view.collectionState==="authorized"?"Automatic collection is authorized for the remaining agreed schedule.":
      view.collectionState==="complete"?"All scheduled installments are recorded as paid. Your service duration follows its separate terms.":
      view.collectionState==="paused"?"Future automatic collection is paused. Check the original payment receipt to recover any saved authorization, or contact support.":
      "Automatic collection has not been activated."}</p>}
    {view.canStopDebit && <section className="mt-6 rounded-xl border border-white/20 p-4" aria-label="Stop automatic payments">
      <h2 className="font-semibold">Stop automatic payments</h2>
      <p className="mt-2 text-sm text-white/70">This stops new automatic payments. A payment already in progress may still finish. It does not cancel your mentorship or erase your agreed unpaid balance.</p>
      <label className="mt-3 flex gap-3 text-sm"><input type="checkbox" checked={stopAccepted} disabled={busy} onChange={e=>setStopAccepted(e.target.checked)}/><span>I understand and want to stop new automatic payments.</span></label>
      <button className={`${button} mt-3`} disabled={busy||!stopAccepted} onClick={()=>void stopDebit()}>Stop new automatic payments</button>
    </section>}
    {!view.payments.length && <p className="mt-8">Your accepted plan is saved. The first payment has not been verified here.</p>}
    <div className="mt-8 space-y-4">{view.payments.map(p=><section key={p.paymentNumber} className="rounded-2xl border border-white/15 p-5" aria-label={`Payment ${p.paymentNumber}`}>
      <h2 className="text-lg font-semibold">Payment {p.paymentNumber} · {money(p.amountCents)}</h2>
      <p className="mt-1 text-sm text-white/60">{new Date(p.dueAt*1000).toLocaleDateString("en-US",{timeZone:"UTC",month:"long",day:"numeric",year:"numeric"})}</p>
      <p className="mt-3">{labels[p.outcome]??"Support review needed"}</p>
      {p.canVerifyBank && <div className="mt-4 space-y-3">
        <label className="flex gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 h-5 w-5" checked={accepted===p.paymentNumber} disabled={busy||uncertain}
          onChange={e=>setAccepted(e.target.checked?p.paymentNumber:null)}/><span>Continue bank verification for my existing {money(p.amountCents)} installment. Completing verification may finish this payment.</span></label>
        <button className={`${button} bg-[#7250df]`} disabled={busy||uncertain||accepted!==p.paymentNumber} onClick={()=>void bank(p,true)}>Verify with my bank</button>
      </div>}
      {p.canCheck && <button className={`${button} mt-3`} disabled={busy} onClick={()=>void bank(p,false)}>Check payment receipt</button>}
      {p.outcome==="payment_method_required" && <p className="mt-3 text-sm text-white/60">Contact support about this original payment. Do not start another purchase.</p>}
      {(p.canStartCard||p.cardSetup?.canPrepare) && <div className="mt-4 space-y-3">
        <label className="flex gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 h-5 w-5" checked={cardAccepted===p.paymentNumber} disabled={busy}
          onChange={e=>setCardAccepted(e.target.checked?p.paymentNumber:null)}/><span>{CARD_SETUP_CONSENT_TEXT}</span></label>
        <button className={button} disabled={busy||cardAccepted!==p.paymentNumber} onClick={()=>void cardAction(p,"prepare_card")}>Prepare secure card setup</button>
      </div>}
      {p.retry && <div className="mt-4 space-y-3">
        {p.retry.admitted?<p className="text-sm">A replacement-card payment attempt is already recorded. Check its result above before taking further action.</p>:<>
          {p.retry.canReview && <button className={button} disabled={busy||uncertain||view.debitStopped||view.financialReview} onClick={()=>void retryAction(p,false)}>Review replacement-card payment</button>}
          {p.retry.quote && <>
            <p>Review: {money(p.retry.quote.amountCents)} for payment {p.paymentNumber}. Valid until {new Date(p.retry.quote.expiresAt*1000).toLocaleString("en-US",{timeZone:"UTC"})} UTC.</p>
            {p.retry.canPay && !p.retry.quote.futureCardAccepted && <>
              <label className="flex gap-3 text-sm leading-6"><input type="checkbox" checked={payAccepted===p.retry.quote.id} disabled={busy||uncertain||view.debitStopped||view.financialReview}
                onChange={e=>setPayAccepted(e.target.checked?p.retry!.quote!.id:null)}/><span>{retryConsentText(money(p.retry.quote.amountCents),Boolean(p.retry.quote.remainingPayments))}</span></label>
              {p.retry.quote.remainingPayments && <div className="rounded-xl border border-white/15 p-4">
                <h3 className="font-semibold">Card for your remaining installments</h3>
                <ul className="mt-3 space-y-2 text-sm" aria-label="Remaining scheduled payments">
                  {p.retry.quote.remainingPayments.map(next=><li key={next.paymentNumber}>Payment {next.paymentNumber} · {money(next.amountCents)} · {new Date(next.dueAt*1000).toLocaleDateString("en-US",{timeZone:"UTC",month:"long",day:"numeric",year:"numeric"})} (UTC)</li>)}
                </ul>
                <label className="mt-4 flex gap-3 text-sm leading-6"><input type="checkbox" checked={futureAccepted===p.retry.quote.id}
                  disabled={busy||uncertain||view.debitStopped||view.financialReview||!p.retry.canUseFutureCard}
                  onChange={e=>setFutureAccepted(e.target.checked?p.retry!.quote!.id:null)}/><span>{FUTURE_CARD_CONSENT_TEXT}</span></label>
                <p className="mt-3 text-sm text-white/60">Leave unchecked to use this card for the payment above only. Future collection stays paused for review; the remaining balance is not waived.</p>
              </div>}
              <button className={button} disabled={busy||uncertain||view.debitStopped||view.financialReview||attempted.includes(p.retry.quote.id)||payAccepted!==p.retry.quote.id}
                onClick={()=>void retryAction(p,true)}>Pay {money(p.retry.quote.amountCents)} with saved replacement card</button>
            </>}
          </>}
        </>}
      </div>}
      {p.cardSetup && <div className="mt-3 space-y-3">
        <p className="text-sm text-white/60">{p.cardSetup.state==="verified"?(p.retry?.admitted || p.outcome==="paid_accounted"?"Replacement card saved.":"Replacement card saved. No payment authorized."):p.cardSetup.state==="expired"?
          "The saved setup has expired. Check its status or contact support; a new setup has not been created.":"Your original card setup request is saved."}</p>
        {p.cardSetup.canOpen && <button className={button} disabled={busy} onClick={()=>void cardAction(p,"open_card")}>Open secure card setup</button>}
        {p.cardSetup.canVerify && <button className={`${button} ml-2`} disabled={busy} onClick={()=>void cardAction(p,"verify_card")}>Check saved card</button>}
      </div>}
    </section>)}</div>
    <p role="status" aria-live="polite" className="mt-6 text-sm leading-6 text-[#d2c5ff]">{message}</p>
    <footer className="mt-6 flex flex-wrap gap-5"><button className={button} disabled={busy} onClick={()=>void refresh()}>Refresh records</button>
      <a className="inline-flex min-h-11 items-center underline" href="mailto:support@creatornet.net">Contact support</a></footer>
  </main>;
}
