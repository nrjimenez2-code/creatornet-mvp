"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useUser } from "@/lib/useUser";
import { TEAM_COMMISSION_TERMS_VERSION } from "@/lib/salesTeams/policy";
import styles from "../app/dashboard/closers/bookings.module.css";
import SalesTeamOfferControls from "@/components/SalesTeamOfferControls";
import SalesTeamBookingCheckout from "@/components/SalesTeamBookingCheckout";
import {MemberTermsControl,DestinationWeightControl,BookingAssignmentControl} from "@/components/SalesTeamManagementControls";

type Member={id:string;user_id:string;role:"manager"|"closer";is_closer:boolean;status:string;commission_bps:number;hold_days:number;renewal_rule:string;commission_revision:number;accepted_commission_revision:number|null};
type Team={creatorId:string;role:"owner"|"manager"|"closer";membershipId:string|null;members:Member[];enabled:boolean;routingEnabled:boolean;
 invitations:{id:string;email:string;role:string;accepted_at:string|null;revoked_at:string|null;expires_at:string;expired:boolean}[];
 targets:{id:string;name:string|null;booking_url:string;weight:number;active:boolean;is_active:boolean}[];
 bindings:{target_id:string;membership_id:string}[];readiness:{membershipId:string;ready:boolean}[]};
type Booking={booking:{id:string;status:string;created_at:string};post:{title:string|null}|null;buyer:{full_name:string|null;username:string|null}|null;
 assignment:{membership_id:string;source:string;accepted_sale_id:string|null}|null};
type TeamChoice={creator_id:string;role:string;status:string};

export default function SalesTeamDashboard(){
 const {userId,session,loading:authLoading}=useUser(),params=useSearchParams(),router=useRouter();
 const selected=params.get("creator_id")||userId||"",invitation=params.get("invitation");
 const [team,setTeam]=useState<Team|null>(null),[choices,setChoices]=useState<TeamChoice[]>([]),[bookings,setBookings]=useState<Booking[]>([]);
 const [loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const busyRef=useRef(false),savedInvite=useRef<Record<string,unknown>|null>(null);
 const [hasSavedInvite,setHasSavedInvite]=useState(false),[loadedScope,setLoadedScope]=useState("");
 const scope=JSON.stringify([userId,selected]);
 const [email,setEmail]=useState(""),[role,setRole]=useState("closer"),[alsoCloses,setAlsoCloses]=useState(false);
 const [percent,setPercent]=useState(""),[holdDays,setHoldDays]=useState(14),[renewal,setRenewal]=useState("initial_commitment");
 const [invitationUrl,setInvitationUrl]=useState<string|null>(null),[accepted,setAccepted]=useState(false);
 const [checkoutBooking,setCheckoutBooking]=useState<string|null>(null);
 const token=session?.access_token;
 const api=useCallback(async(path:string,body?:Record<string,unknown>,signal?:AbortSignal)=>{
  const response=await fetch(path,{method:body?"POST":"GET",credentials:"include",signal,
   headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw Error(result.error||"The team operation needs review.");return result;
 },[token]);
 const load=useCallback(async(signal?:AbortSignal)=>{
  if(!selected||!userId)return;
  setLoading(true);setError(null);
  try{
   const [list,details]=await Promise.all([api("/api/sales-team",undefined,signal),api(`/api/sales-team?creator_id=${encodeURIComponent(selected)}`,undefined,signal)]);
   if(signal?.aborted)return;setChoices(list.memberships);setTeam(details);
   if(details.role!=="closer"||details.readiness.some((r:{membershipId:string;ready:boolean})=>r.membershipId===details.membershipId&&r.ready)){
    const result=await api(`/api/bookings/list?creator_id=${encodeURIComponent(selected)}`,undefined,signal);if(!signal?.aborted)setBookings(result.bookings);
   }else setBookings([]);
  }catch(e){if(!signal?.aborted){setTeam(null);setBookings([]);setError(e instanceof Error?e.message:"Could not load the team.");}}
  finally{if(!signal?.aborted){setLoadedScope(JSON.stringify([userId,selected]));setLoading(false);}}
 },[api,selected,userId]);
 useEffect(()=>{const controller=new AbortController();const timer=window.setTimeout(()=>{if(!authLoading&&userId)void load(controller.signal);},0);return()=>{window.clearTimeout(timer);controller.abort();};},[load,authLoading,userId]);
 const change=async(body:Record<string,unknown>,path="/api/sales-team")=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);setNotice(null);
  try{const result=await api(path,{...body,creator_id:selected});if(result.invitationUrl){setInvitationUrl(result.invitationUrl);savedInvite.current=null;setHasSavedInvite(false);setEmail("");}
   setNotice("Saved.");setAccepted(false);await load();
  }catch(e){setError(e instanceof Error?e.message:"The change needs review.");}
  finally{busyRef.current=false;setBusy(false);}
 };
 const invite=(event:FormEvent)=>{
  event.preventDefault();if(!savedInvite.current){const bytes=crypto.getRandomValues(new Uint8Array(32));savedInvite.current={action:"invite",request_id:crypto.randomUUID(),
   token:Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""),email,role,is_closer:role==="closer"||alsoCloses,
   commission_bps:Math.round(Number(percent)*100),hold_days:holdDays,renewal_rule:renewal};}
  setHasSavedInvite(true);void change(savedInvite.current);
 };
 if(authLoading||(userId&&(loading||loadedScope!==scope)))return <main className={styles.page} aria-busy="true"><div className={styles.content}>Loading your sales team…</div></main>;
 if(!userId)return <main className={styles.page}><div className={styles.content}><h1>Sales team</h1><p>Sign in with your own CreatorNet login to continue.</p><Link href="/auth">Sign in</Link></div></main>;
 const manage=team?.role==="owner"||team?.role==="manager",own=team?.members.find(m=>m.id===team.membershipId);
 return <main className={styles.page}><div className={styles.content}>
  <Link href="/dashboard/closers">← Bookings</Link><header className={styles.header}><h1>Sales team</h1><p>Assigned calls, approved offers, and commission agreements.</p></header>
  <Link href={`/dashboard/closers/earnings?creator_id=${encodeURIComponent(selected)}`}>Commission statements</Link>
  <label htmlFor="team-context">Creator team</label><select id="team-context" value={selected} disabled={busy} onChange={e=>{router.push(`/dashboard/closers/team?creator_id=${encodeURIComponent(e.target.value)}`);}}>
   <option value={userId}>Your team</option>{choices.filter(c=>c.creator_id!==userId&&c.status==="active").map(c=><option key={c.creator_id} value={c.creator_id}>{c.creator_id} · {c.role}</option>)}
  </select>
  {error?<p role="alert">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
  {invitation?<section className={styles.panel}><h2>Team invitation</h2><p>Accept using the verified email the invitation was sent to. Commission acceptance and payout setup follow separately.</p>
   <button className={styles.primary} disabled={busy} onClick={()=>void change({action:"accept_invitation",token:invitation})}>Accept invitation</button></section>:null}
  {!team?<button onClick={()=>void load()} disabled={busy}>Retry loading</button>:<>
   {!team.enabled?<p>New team activity is currently disabled.</p>:null}
   {own?<section className={styles.panel}><h2>Your commission agreement</h2><p>{(own.commission_bps/100).toFixed(2)}% of collected sale subtotal, excluding tax and refunded revenue. Payments are held for {own.hold_days} days.</p>
    <p>{own.renewal_rule==="every_renewal"?"Commission continues on each paid renewal.":"Commission covers the initial commitment only; without a minimum commitment, this means the first paid month."} Existing accepted sale agreements continue after departure. Refunds reduce unpaid commission; released amounts may be recovered or offset against future commission from this creator.</p>
    {own.accepted_commission_revision!==own.commission_revision?<><label><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} /> I accept these commission terms.</label>
     <button disabled={!accepted||busy||!team.enabled} onClick={()=>void change({action:"accept_terms",revision:own.commission_revision,version:TEAM_COMMISSION_TERMS_VERSION,accepted:true})}>Accept commission terms</button></>:<p>Current commission terms accepted.</p>}
    {own.is_closer&&!team.readiness.find(r=>r.membershipId===own.id)?.ready?<p>Payout setup or recipient verification is still required before customer bookings and checkout access are available.</p>:null}
   </section>:null}
   {manage?<>
    <section className={styles.panel}><h2>Routing</h2><p>Only active linked closers with accepted terms and verified payout setup receive bookings.</p><label><input type="checkbox" checked={team.routingEnabled} disabled={busy||!team.enabled}
     onChange={e=>void change({action:"configure_routing",enabled:e.target.checked})} /> Use team routing for new bookings</label></section>
    <section className={styles.panel}><h2>Invite a team member</h2><form onSubmit={invite} className={styles.formGrid}>
     <label>Email<input type="email" required value={email} disabled={busy||hasSavedInvite} onChange={e=>setEmail(e.target.value)} /></label>
     <label>Role<select value={role} disabled={busy||hasSavedInvite} onChange={e=>setRole(e.target.value)}><option value="closer">Closer</option>{team.role==="owner"?<option value="manager">Manager</option>:null}</select></label>
     {role==="manager"?<label><input type="checkbox" checked={alsoCloses} disabled={busy} onChange={e=>setAlsoCloses(e.target.checked)} /> This manager also closes sales</label>:null}
     <label>Commission (%)<input type="number" min="0" max="88" step="0.01" required value={percent} disabled={busy||hasSavedInvite} onChange={e=>setPercent(e.target.value)} /></label>
     <label>Holding period (days)<input type="number" min="14" max="90" required value={holdDays} disabled={busy||hasSavedInvite} onChange={e=>setHoldDays(Number(e.target.value))} /></label>
     <label>Ongoing-service commission<select value={renewal} disabled={busy||hasSavedInvite} onChange={e=>setRenewal(e.target.value)}><option value="initial_commitment">Initial commitment only</option><option value="every_renewal">Every paid renewal</option></select></label>
     <button type="submit" disabled={busy||!team.enabled}>{hasSavedInvite?"Retry saved invitation":"Create invitation link"}</button>
    </form><p>Share the invitation link with this person. It does not grant website tester or platform administrator access.</p>
    {invitationUrl?<label>Invitation link<input readOnly value={invitationUrl} onFocus={e=>e.target.select()} /></label>:null}</section>
    <section className={styles.panel}><h2>Members and destinations</h2>{team.members.map(member=><article key={member.id} className={styles.panel}>
     <h3>{member.user_id} · {member.role}</h3><p>{member.status} · {(member.commission_bps/100).toFixed(2)}% commission · {member.hold_days}-day hold · {team.readiness.find(r=>r.membershipId===member.id)?.ready?"Ready to close":"Setup required"}</p>
     {member.is_closer&&member.status==="active"?<label>Linked calendar<select value={team.bindings.find(b=>b.membership_id===member.id)?.target_id||""} disabled={busy||!team.enabled}
      onChange={e=>{if(e.target.value)void change({action:"bind_destination",membership_id:member.id,target_id:e.target.value});}}><option value="">Choose an explicit calendar binding</option>{team.targets.map(t=><option key={t.id} value={t.id}>{t.name||t.booking_url} · weight {t.weight}</option>)}</select></label>:null}
     {member.status!=="removed"&&(team.role==="owner"||member.role==="closer")?<button disabled={busy||!team.enabled} onClick={()=>void change({action:"remove_member",membership_id:member.id})}>Remove team access</button>:null}
     <MemberTermsControl key={`${member.id}:${member.commission_revision}`} member={member} owner={team.role==="owner"} disabled={busy||!team.enabled} onChange={change}/>
    </article>)}</section>
    <section className={styles.panel}><h2>Destination routing weights</h2>{team.targets.map(target=><DestinationWeightControl key={`${target.id}:${target.weight}:${target.active}:${target.is_active}`} target={target} disabled={busy||!team.enabled} onChange={change}/>)}</section>
    <section className={styles.panel}><SalesTeamOfferControls key={selected} creatorId={selected} enabled={team.enabled}/></section>
    <section className={styles.panel}><h2>Invitations</h2>{team.invitations.map(inv=><p key={inv.id}>{inv.email} · {inv.role} · {inv.accepted_at?"Accepted":inv.revoked_at?"Revoked":inv.expired?"Expired":"Awaiting acceptance"}
     {!inv.accepted_at&&!inv.revoked_at&&(team.role==="owner"||inv.role==="closer")?<button disabled={busy} onClick={()=>void change({action:"revoke_invitation",invitation_id:inv.id})}>Revoke invitation</button>:null}</p>)}</section>
   </>:null}
   <section className={styles.panel}><h2>{manage?"Team bookings":"Your assigned bookings"}</h2>{bookings.length?bookings.map(item=><article key={item.booking.id} className={styles.panel}>
    <h3>{item.post?.title||"Booked offer"}</h3><p>{item.buyer?.full_name||item.buyer?.username||"Customer"} · {item.booking.status==="booked"?"Lead saved; scheduling confirmation is separate":item.booking.status.replaceAll("_"," ")}</p>
    <p>{item.assignment?`Assigned closer: ${item.assignment.membership_id} (${item.assignment.source})`:"Awaiting explicit closer assignment"}{item.assignment?.accepted_sale_id?" · Sale attribution fixed":""}</p>
    {manage&&!item.assignment?.accepted_sale_id?<BookingAssignmentControl bookingId={item.booking.id} current={item.assignment?.membership_id||null}
     eligible={team.members.filter(m=>m.status==="active"&&m.is_closer&&team.readiness.some(r=>r.membershipId===m.id&&r.ready))} disabled={busy||!team.enabled} onChange={change}/>:null}
    {item.assignment?<button disabled={busy} onClick={()=>setCheckoutBooking(item.booking.id)}>Approved checkout options</button>:null}
   </article>):<p>No available bookings.</p>}</section>
   {checkoutBooking?<section className={styles.panel}><button onClick={()=>setCheckoutBooking(null)}>Close checkout options</button><SalesTeamBookingCheckout key={checkoutBooking} creatorId={selected} bookingId={checkoutBooking} enabled={team.enabled}/></section>:null}
  </>}
 </div></main>;
}
