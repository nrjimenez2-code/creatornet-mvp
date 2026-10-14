import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "@/lib/installments/contextRuntime";
import {recoverProductCheckoutOriginalRequest} from "@/lib/productCheckoutOriginalRequest";
import {attachOriginalProductCheckout} from "@/lib/productCheckoutAttachment";
import {PRODUCT_CHECKOUT_STOP_FLAGS} from "@/lib/productCheckoutStop";
import {isDeepStrictEqual} from "node:util";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",Vary:"Cookie, Authorization"}});

/** Read-only owner capability. Never dispatch provider operations on navigation. */
export async function GET(req:NextRequest){
 try{
  const user=await getAuthenticatedUser(req);
  if(!user)return json({error:"Sign in to recover your checkout."},401);
  const params=req.nextUrl.searchParams,productId=params.get("product_id")??"",attemptId=params.get("attempt_id");
  try{assertAgreementId(productId);if(attemptId!==null)assertAgreementId(attemptId);
   if([...params.keys()].some(key=>!["product_id","attempt_id"].includes(key))||params.getAll("product_id").length!==1||params.getAll("attempt_id").length>1)throw Error();}
  catch{return json({error:"Invalid checkout recovery request."},400);}
  if(process.env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY!=="true")
   return json({error:"Checkout recovery is not enabled. Your original selection remains locked."},409);
  const config=exactContextServerConfig();
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  let query=admin.from("product_checkout_attempts").select("*").eq("buyer_id",user.id).eq("product_id",productId).eq("checkout_kind","full");
  if(attemptId)query=query.eq("id",attemptId);
  const result=await query.maybeSingle();
  if(result.error)throw Error();
  const a=result.data;
  if(!a){
   if(attemptId&&process.env.CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY==="true"){
    const archived=await admin.from("product_checkout_releases_v1").select("*").eq("attempt_id",attemptId).eq("buyer_id",user.id).eq("product_id",productId).maybeSingle();
    if(archived.error)throw Error();const h=archived.data;
    if(h){
     const original=h.original_attempt;
     if(h.attempt_id!==attemptId||h.buyer_id!==user.id||h.product_id!==productId||!isDeepStrictEqual(h.context,config.approvedContext)||
       original?.id!==attemptId||original.buyer_id!==user.id||original.product_id!==productId||!original.purchase_consent_id||
       typeof h.released_at!=="string"||!Number.isFinite(Date.parse(h.released_at))||Date.parse(h.released_at)>Date.now()+5000)throw Error();
     const accepted=await admin.from("product_purchase_consents_v1").select("buyer_id,product_id,fingerprint").eq("id",original.purchase_consent_id).eq("buyer_id",user.id).eq("product_id",productId).maybeSingle();
     if(accepted.error||accepted.data?.buyer_id!==user.id||accepted.data.product_id!==productId||!(/^[a-f0-9]{64}$/).test(accepted.data.fingerprint))throw Error();
     return json({attemptId,productId,buyerId:user.id,status:"released",releasedAt:h.released_at,fingerprint:accepted.data.fingerprint,
      canRecover:false,canStopUnpaid:false,accessGranted:false,canSwitchPaymentMode:true});
    }
   }
   return json({error:"Saved checkout not found. Contact support before starting another payment."},404);
  }
  if(a.buyer_id!==user.id||a.product_id!==productId||a.checkout_kind!=="full"||attemptId&&a.id!==attemptId)throw Error();
  const canRecover=a.original_request_protocol==="product-checkout-original-v1"&&Boolean(a.original_request)&&!a.original_stop_requested_at&&
   ["CREATOR_PRODUCT_CHECKOUT_RECOVERY_READY","CREATOR_PRODUCT_CHECKOUT_RECOVERY_UI_READY",
    "CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY"].every(key=>process.env[key]==="true");
  const canStopUnpaid=a.original_request_protocol==="product-checkout-original-v1"&&Boolean(a.original_request)&&Boolean(a.stripe_checkout_session_id)&&
   PRODUCT_CHECKOUT_STOP_FLAGS.every(key=>process.env[key]==="true");
  let acceptance:{}|{buyerId:string;fingerprint:string}={};
  if(canStopUnpaid){
   if(!a.purchase_consent_id)throw Error();
   const accepted=await admin.from("product_purchase_consents_v1").select("buyer_id,product_id,fingerprint").eq("id",a.purchase_consent_id).eq("buyer_id",user.id).eq("product_id",productId).maybeSingle();
   if(accepted.error||accepted.data?.buyer_id!==user.id||accepted.data.product_id!==productId||!(/^[a-f0-9]{64}$/).test(accepted.data.fingerprint))throw Error();
   acceptance={buyerId:user.id,fingerprint:accepted.data.fingerprint};
  }
  return json({attemptId:a.id,productId,status:"saved_checkout",canRecover,canStopUnpaid,...acceptance,accessGranted:false,canSwitchPaymentMode:false});
 }catch{return json({error:"Your original checkout needs review. Contact support before starting another payment."},409);}
}

/** Explicit owner action; can replay only an already persisted original create.
 * No catalog lookup, fresh consent, new attempt/key, accounting or lock release. */
export async function POST(req:NextRequest){
 try{
  const user=await getAuthenticatedUser(req);
  if(!user)return json({error:"Sign in to recover your checkout."},401);
  if(!["CREATOR_PRODUCT_CHECKOUT_RECOVERY_READY","CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY",
    "CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY"].every(key=>process.env[key]==="true"))
    return json({error:"Checkout recovery is not enabled."},409);
  let productId:string,attemptId:string|undefined;
  try{
    const body=await req.json();
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["productId","attemptId"].includes(key)))throw Error();
    assertAgreementId(body.productId);productId=body.productId;
    if("attemptId" in body){assertAgreementId(body.attemptId);attemptId=body.attemptId;}
    if(req.nextUrl.searchParams.size)throw Error();
  }catch{return json({error:"Invalid checkout recovery request."},400);}
  const config=exactContextServerConfig();
  if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
  const observation=await createExactContextRuntime(config).observeContext();assertFreshExactRuntimeContextObservation(observation);
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  // More than one matching row is review-required; never pick a random attempt.
  let query=admin.from("product_checkout_attempts").select("id,buyer_id,product_id,attempt_key,checkout_kind,original_request_protocol")
    .eq("buyer_id",user.id).eq("product_id",productId).eq("checkout_kind","full");
  if(attemptId)query=query.eq("id",attemptId);
  const result=await query.maybeSingle();
  if(result.error)throw Error();
  const a=result.data;
  if(!a)return json({error:"Saved checkout not found."},404);
  if(a.buyer_id!==user.id||a.product_id!==productId||a.checkout_kind!=="full"||a.original_request_protocol!=="product-checkout-original-v1"||attemptId&&a.id!==attemptId)throw Error();
  const session=await recoverProductCheckoutOriginalRequest({buyerId:user.id,attemptId:a.id,attemptKey:a.attempt_key});
  const view={attemptId:a.id,productId,sessionId:session.id,accessGranted:false,canSwitchPaymentMode:false};
  if(session.status==="open"&&session.payment_status==="unpaid"&&session.url){
    const url=new URL(session.url);
    if(url.protocol!=="https:"||url.hostname!=="checkout.stripe.com"||url.username||url.password||url.port)throw Error();
    await attachOriginalProductCheckout({admin,buyerId:user.id,attemptId:a.id,attemptKey:a.attempt_key,session});
    return json({...view,status:"checkout_open",url:session.url});
  }
  // Completed or expired provider state is not independently verified capture
  // or terminal unpaid stop proof. Preserve the existing financial/release work.
  return json({...view,status:"reconciliation_required"});
 }catch{return json({error:"The original checkout needs reconciliation. Your saved attempt has been preserved."},409);}
}
