"use client";
import { useState,type FormEvent } from "react";

type Change=(body:Record<string,unknown>,path?:string)=>Promise<void>;
export type ManagedTeamMember={id:string;user_id:string;role:"manager"|"closer";is_closer:boolean;status:string;commission_bps:number;hold_days:number;renewal_rule:string;commission_revision:number};
export function MemberTermsControl({member,owner,disabled,onChange}:{member:ManagedTeamMember;owner:boolean;disabled:boolean;onChange:Change}){
 const [role,setRole]=useState(member.role),[closes,setCloses]=useState(member.is_closer),[percent,setPercent]=useState(String(member.commission_bps/100)),
  [hold,setHold]=useState(member.hold_days),[renewals,setRenewals]=useState(member.renewal_rule);
 if(member.status!=="active"||!owner&&member.role==="manager")return null;
 const submit=(event:FormEvent)=>{event.preventDefault();void onChange({action:"configure_member",membership_id:member.id,expected_revision:member.commission_revision,
  role,is_closer:role==="closer"||closes,commission_bps:Math.round(Number(percent)*100),hold_days:hold,renewal_rule:renewals});};
 return <details><summary>Edit future commission terms</summary><form onSubmit={submit}>
  <p>Changes apply to future accepted sales. Existing agreements keep their saved terms. This member must accept changed terms before receiving new bookings.</p>
  {owner?<label>Member role<select value={role} disabled={disabled} onChange={e=>setRole(e.target.value as "closer"|"manager")}><option value="closer">Closer</option><option value="manager">Manager</option></select></label>:null}
  {role==="manager"?<label><input type="checkbox" checked={closes} disabled={disabled} onChange={e=>setCloses(e.target.checked)}/> Manager also closes sales</label>:null}
  <label>Future commission (%)<input type="number" min="0" max="88" step="0.01" required value={percent} disabled={disabled} onChange={e=>setPercent(e.target.value)}/></label>
  <label>Future holding period (days)<input type="number" min="14" max="90" required value={hold} disabled={disabled} onChange={e=>setHold(Number(e.target.value))}/></label>
  <label>Future renewal eligibility<select value={renewals} disabled={disabled} onChange={e=>setRenewals(e.target.value)}><option value="initial_commitment">Initial commitment only</option><option value="every_renewal">Every paid renewal</option></select></label>
  <button disabled={disabled}>Save future terms</button>
 </form></details>;
}
export function DestinationWeightControl({target,disabled,onChange}:{target:{id:string;name:string|null;booking_url:string;weight:number;active:boolean;is_active:boolean};disabled:boolean;onChange:Change}){
 const [weight,setWeight]=useState(target.weight),[enabled,setEnabled]=useState(target.active&&target.is_active);
 const submit=(event:FormEvent)=>{event.preventDefault();void onChange({action:"configure_destination",target_id:target.id,weight,enabled});};
 return <form onSubmit={submit}><h3>{target.name||target.booking_url}</h3>
  <label>Routing weight<input type="number" required min="0" max="1000" value={weight} disabled={disabled} onChange={e=>setWeight(Number(e.target.value))}/></label>
  <label><input type="checkbox" checked={enabled} disabled={disabled} onChange={e=>setEnabled(e.target.checked)}/> Destination enabled</label>
  <p>Weight zero excludes this destination. A calendar also needs an explicit binding to an eligible closer.</p>
  <button disabled={disabled}>Save destination routing</button></form>;
}
export function BookingAssignmentControl({bookingId,current,eligible,disabled,onChange}:{bookingId:string;current:string|null;eligible:ManagedTeamMember[];disabled:boolean;onChange:Change}){
 const [selected,setSelected]=useState(eligible.some(m=>m.id===current)?current||"":"");
 const submit=(event:FormEvent)=>{event.preventDefault();if(selected)void onChange({booking_id:bookingId,membership_id:selected},"/api/sales-team/assignments");};
 return <form onSubmit={submit}><label>Assign an eligible closer<select required value={selected} disabled={disabled} onChange={e=>setSelected(e.target.value)}><option value="">Choose a closer</option>
  {eligible.map(m=><option key={m.id} value={m.id}>{m.user_id}</option>)}</select></label><button disabled={disabled||!selected||selected===current}>Save booking assignment</button></form>;
}
