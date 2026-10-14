import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {PRODUCT_CHECKOUT_STOP_FLAGS,stopOriginalProductCheckout} from "@/lib/productCheckoutStop";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",Vary:"Cookie, Authorization"}});
export async function POST(req:NextRequest){
 try{
  const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to stop your original checkout."},401);
  if(!PRODUCT_CHECKOUT_STOP_FLAGS.every(key=>process.env[key]==="true"))return json({error:"Checkout stopping is not enabled."},409);
  let attemptId:string;
  try{const body=await req.json();if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).join(",")!=="attemptId"||req.nextUrl.searchParams.size)throw Error();
   assertAgreementId(body.attemptId);attemptId=body.attemptId;
  }catch{return json({error:"Invalid original checkout stop request."},400);}
  const config=exactContextServerConfig();if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const active=await admin.from("product_checkout_attempts").select("id,buyer_id,attempt_key,checkout_kind,original_request_protocol").eq("id",attemptId).eq("buyer_id",user.id).maybeSingle();
  if(active.error)throw Error();
  let attemptKey:string;
  if(active.data){const a=active.data;if(a.id!==attemptId||a.buyer_id!==user.id||a.checkout_kind!=="full"||a.original_request_protocol!=="product-checkout-original-v1")throw Error();attemptKey=a.attempt_key;}
  else{
   const archived=await admin.from("product_checkout_releases_v1").select("attempt_id,buyer_id,attempt_key").eq("attempt_id",attemptId).eq("buyer_id",user.id).maybeSingle();
   if(archived.error||!archived.data||archived.data.attempt_id!==attemptId||archived.data.buyer_id!==user.id)throw Error();attemptKey=archived.data.attempt_key;
  }
  const result=await stopOriginalProductCheckout({buyerId:user.id,attemptId,attemptKey});
  return json({...result,accessGranted:false});
 }catch{return json({error:"Stopping this checkout needs reconciliation. Your original payment records remain preserved."},409);}
}
