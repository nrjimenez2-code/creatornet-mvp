import type {Metadata} from "next";
import {notFound,redirect} from "next/navigation";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {buyerMentorshipManagementEnabled,readBuyerMentorshipManagement} from "@/lib/mentorshipInstallmentManagement";
import {MentorshipPaymentManagement} from "./MentorshipPaymentManagement";
export const dynamic="force-dynamic";
export const metadata:Metadata={title:"Mentorship payments",robots:{index:false,follow:false},referrer:"no-referrer"};
export default async function Page({params}:{params:Promise<{requestId:string}>}) {
  if(!buyerMentorshipManagementEnabled(process.env))notFound();
  const {requestId}=await params;try{assertAgreementId(requestId);}catch{notFound();}
  const user=await getAuthenticatedUser();if(!user)redirect(`/auth?next=${encodeURIComponent(`/payments/mentorship/${requestId}`)}`);
  let view;try{view=await readBuyerMentorshipManagement({buyerId:user.id,requestId});}catch{notFound();}
  if(!view)notFound();
  return <MentorshipPaymentManagement initial={view}/>;
}
