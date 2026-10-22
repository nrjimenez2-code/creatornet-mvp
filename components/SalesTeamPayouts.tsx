"use client";
import Link from "next/link";
import {useCallback,useEffect,useRef,useState} from "react";
import {useUser} from "@/lib/useUser";
import {useTeamApi} from "@/lib/salesTeams/client";
import {createClient} from "@/lib/supabaseClient";
import {prepareSessionNavigation} from "@/lib/browserSession";
import type {TeamRecipientStatus} from "@/lib/salesTeams/policy";
import styles from "../app/dashboard/closers/bookings.module.css";
type View={recipient:TeamRecipientStatus;onboardingEnabled:boolean;onboarding:{id:string;status:string;expires_at:string|null}|null};
const labels={not_started:"Payout setup has not started.",verification_required:"Your payout account needs a current verification.",setup_required:"Complete the remaining requirements with Stripe.",ready:"Your account is currently eligible for transfers and bank payouts."};
export default function SalesTeamPayouts(){
 const {userId,loading:authLoading}=useUser();
 if(authLoading)return <main className={styles.page} aria-busy="true">Loading payout setup…</main>;
 if(!userId)return <main className={styles.page}><h1>Payout setup</h1><p>Sign in with your own CreatorNet login.</p><Link href="/auth">Sign in</Link></main>;
 return <PayoutSetup key={userId} userId={userId}/>;
}
function PayoutSetup({userId}:{userId:string}){
 const api=useTeamApi();
 const [view,setView]=useState<View|null>(null),[loadedUser,setLoadedUser]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const working=useRef(false),requestIdentity=useRef<string|null>(null),mounted=useRef(false);
 const load=useCallback(async(signal?:AbortSignal)=>{
  if(!userId)return;
  try{const result=await api("/api/sales-team/recipient",undefined,signal);if(!signal?.aborted&&mounted.current){setView(result);setError(null);setLoadedUser(userId);}}
  catch(reason){if(!signal?.aborted&&mounted.current){setView(null);setError(reason instanceof Error?reason.message:"Could not read your payout setup.");setLoadedUser(userId);}}
 },[api,userId]);
 useEffect(()=>{mounted.current=true;const controller=new AbortController();const timer=window.setTimeout(()=>{void load(controller.signal);},0);return()=>{mounted.current=false;window.clearTimeout(timer);controller.abort();};},[load]);
 const change=async(onboard:boolean)=>{
  if(!userId||working.current)return;working.current=true;setBusy(true);setError(null);
  const storageKey=`creatornet-team-onboarding:${userId}`;
  try{
   let requestId:string|null=null;
   if(onboard){
    const client=createClient();
    if(!await prepareSessionNavigation(client))throw Error("Sign in again before continuing payout setup.");
    const current=await client.auth.getSession();
    if(current.error||current.data.session?.user.id!==userId||!mounted.current)throw Error("Your signed-in account changed. Reload payout setup before continuing.");
    const previous=view?.onboarding,expired=previous?.status==="bound"&&Date.parse(previous.expires_at||"")<=Date.now();
    requestId=requestIdentity.current||(!expired?previous?.id:null)||window.sessionStorage.getItem(storageKey);
    if(expired&&requestId===previous?.id)requestId=null;
    requestId=requestId||crypto.randomUUID();requestIdentity.current=requestId;window.sessionStorage.setItem(storageKey,requestId);
   }
   const result=await api("/api/sales-team/recipient",{action:onboard?"onboard":"refresh",...(requestId?{request_id:requestId}:{})});
   if(!mounted.current)return;
   if(result.url){window.location.assign(result.url);return;}
   await load();
  }catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:"Payout setup needs review. Refresh to check the original request.");}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 if(loadedUser!==userId)return <main className={styles.page} aria-busy="true">Loading payout setup…</main>;
 return <main className={styles.page}><div className={styles.content}><Link href="/dashboard/closers">← Bookings</Link><h1>Payout setup</h1>
  <p>Manage your own payout account with Stripe. Each closer must accept their commission terms and complete payout setup before receiving bookings.</p>
  {error?<p role="alert">{error}</p>:null}
  {view?<section className={styles.panel}><h2>Account eligibility</h2><p>{labels[view.recipient.status]}</p>
   <p>Transfers: {view.recipient.transfersActive?"eligible":"held"} · Bank payouts: {view.recipient.payoutsReady?"eligible":"held"}</p>
   <p>Account eligibility does not confirm a bank deposit. Your commission statement records financial obligations separately.</p>
   <button disabled={busy} onClick={()=>void change(false)}>Refresh verification</button>
   {view.recipient.status!=="ready"?<button disabled={busy||!view.onboardingEnabled} onClick={()=>void change(true)}>Continue payout setup with Stripe</button>:null}
   {!view.onboardingEnabled?<p>New setup requests are paused. Existing account verification remains available.</p>:null}
   {view.onboarding&&view.onboarding.status!=="bound"?<p>The original setup-link request needs reconciliation before another link can be requested.</p>:null}
  </section>:<button disabled={busy} onClick={()=>void load()}>Retry loading</button>}
  <p>Removing team access preserves existing commission agreements and your own financial history.</p><Link href="/dashboard/closers/earnings">Commission statements</Link>
 </div></main>;
}
