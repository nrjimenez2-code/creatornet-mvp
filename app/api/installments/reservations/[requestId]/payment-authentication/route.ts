import type {NextRequest} from "next/server";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {authenticateBuyerMentorshipServerPayment} from "@/lib/mentorshipServerPayment";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{
  "Cache-Control":"private, no-store",Vary:"Cookie, Authorization","Referrer-Policy":"no-referrer"}});

/** Capability for the authenticated owner's existing manual bank challenge.
 * No intent creation, token submission, confirmation, release or accounting.
 */
export async function POST(req:NextRequest,route:{params:Promise<{requestId:string}>}){
  const gates=["CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY","CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY",
    "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY","CREATOR_SERVER_PAYMENT_CONFIRMATION_READY",
    "CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY","CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY",
    "CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY"];
  if(!gates.every(key=>process.env[key]==="true"))return json({error:"Bank verification is not enabled."},409);
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to verify your payment."},401);
    const config=exactContextServerConfig();
    if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
    const {requestId}=await route.params;let operationId:string;
    try{
      assertAgreementId(requestId);
      if(req.nextUrl.searchParams.size||req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw Error();
      const text=await req.text();if(text.length>1024)throw Error();const body=JSON.parse(text);
      if(!body||Array.isArray(body)||Object.keys(body).join(",")!=="operationId")throw Error();
      assertAgreementId(body.operationId);operationId=body.operationId;
    }catch{return json({error:"Invalid bank-verification request."},400);}
    const result=await authenticateBuyerMentorshipServerPayment({buyerId:user.id,requestId,operationId});
    if(result.status!=="authentication_required"||result.operationId!==operationId)
      return json({error:"Your original payment needs review before bank verification."},409);
    return json({status:result.status,operationId:result.operationId,paymentIntentId:result.paymentIntentId,clientSecret:result.clientSecret});
  }catch{return json({error:"Your original payment needs review before bank verification."},409);}
}
