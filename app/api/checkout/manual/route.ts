import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "@/lib/installments/contextRuntime";
import {purchasePoliciesActive,PURCHASE_POLICY_VERSION} from "@/lib/purchasePolicies";
import {getProcessingFeeSchedule} from "@/lib/money";
import {resolvePostForProduct} from "@/lib/checkoutGuards";
import {readFullManualCheckoutRequest,findFullManualCheckoutRequest,planFullManualCheckoutRequest,acceptSavedFullManualCheckout} from "@/lib/fullManualCheckoutRequest";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",
  Vary:"Cookie, Authorization","Referrer-Policy":"no-referrer"}});
const projection=(saved:NonNullable<Awaited<ReturnType<typeof readFullManualCheckoutRequest>>>)=>({requestId:saved.requestId,
  buyerId:saved.buyerId,productId:saved.productId,postId:saved.postId,terms:saved.terms,fingerprint:saved.fingerprint,
  status:"saved_selection",providerOperationsAllowed:false,canSwitchPaymentMode:false});
async function view(saved:NonNullable<Awaited<ReturnType<typeof readFullManualCheckoutRequest>>>,owned:Awaited<ReturnType<typeof scope>>){
  const current=projection(saved);
  if(saved.releasedAt)return {...current,status:"released",releasedAt:saved.releasedAt,canSwitchPaymentMode:true};
  if(process.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY!=="true")return current;
  const archive=await owned.admin.from("product_checkout_releases_v1").select("attempt_id,buyer_id,attempt_key")
    .eq("attempt_id",saved.attemptId).eq("buyer_id",saved.buyerId).eq("attempt_key",saved.attemptKey).maybeSingle();
  if(archive.error)throw Error();if(!archive.data)return current;
  const result=await owned.admin.rpc("read_full_manual_release_v1",{p_attempt_id:saved.attemptId,p_buyer_id:saved.buyerId,
    p_attempt_key:saved.attemptKey,p_context:owned.context});
  const h=result.data;
  if(result.error||h?.attempt_id!==saved.attemptId||h.product_id!==saved.productId||typeof h.released_at!=="string"||
    !Number.isFinite(Date.parse(h.released_at))||Date.parse(h.released_at)<=0||Date.parse(h.released_at)>Date.now()+5000)throw Error();
  return {...current,status:"released",releasedAt:h.released_at,canSwitchPaymentMode:true};
}
async function scope(buyerId:string,requestId:string){
  const config=exactContextServerConfig(),observation=await createExactContextRuntime(config).observeContext();
  assertFreshExactRuntimeContextObservation(observation);
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  return {admin,buyerId,requestId,context:config.approvedContext,contextEvidence:observation.contextEvidence};
}

/** Acceptance only. Provider preparation and confirmation require separate
 * owner-scoped actions; this response is never permission to create a charge. */
export async function POST(req:NextRequest){
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to choose a payment option."},401);
    if(!purchasePoliciesActive(process.env)||!["CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY","CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY",
      "CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY","CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY",
      "CREATOR_PROCESSING_FEE_ENABLED"].every(key=>process.env[key]==="true"))return json({error:"Full-payment checkout is not enabled."},409);
    const config=exactContextServerConfig();if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
    let body:any;
    try{
      if(req.nextUrl.searchParams.size||req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw Error();
      const text=await req.text();if(text.length>8192)throw Error();body=JSON.parse(text);
      if(!body||Array.isArray(body)||Object.keys(body).sort().join(",")!=="acceptance,post_id,product_id,request_id")throw Error();
      for(const value of [body.request_id,body.product_id,body.post_id])assertAgreementId(value);
      const a=body.acceptance;
      if(!a||Array.isArray(a)||Object.keys(a).sort().join(",")!=="accepted,fingerprint,version"||a.accepted!==true||
        typeof a.version!=="string"||typeof a.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(a.fingerprint))throw Error();
    }catch{return json({error:"Review and submit the unchanged purchase acceptance."},400);}
    const owned=await scope(user.id,body.request_id);
    let saved=await readFullManualCheckoutRequest(owned);
    if(saved){
      if(saved.productId!==body.product_id||saved.postId!==body.post_id||saved.fingerprint!==body.acceptance.fingerprint||
        saved.terms.version!==body.acceptance.version)return json({error:"This request already holds a different purchase acceptance."},409);
    }else{
      if(body.acceptance.version!==PURCHASE_POLICY_VERSION)return json({error:"Review the current purchase terms."},409);
      const result=await owned.admin.from("products")
        .select("id,creator_id,title,type,description,amount_cents,price_cents,currency,membership_terms,fixed_service_months,active")
        .eq("id",body.product_id).maybeSingle();
      const product=result.data;
      if(result.error||!product||product.active===false||product.type!=="mentorship"||product.membership_terms!=null)
        return json({error:"Offer not available."},404);
      if(await resolvePostForProduct(owned.admin,body.post_id,product.id,product.creator_id)!==body.post_id)
        return json({error:"This post does not sell that offer."},400);
      saved=await planFullManualCheckoutRequest({...owned,product,postId:body.post_id,processingFees:getProcessingFeeSchedule(process.env),acceptance:body.acceptance});
    }
    const status=await view(saved,owned);if(status.status==="released")return json(status);
    const accepted=await acceptSavedFullManualCheckout({...owned,origin:req.headers.get("origin")});
    return json(projection(accepted));
  }catch{return json({error:"Your original full-payment request needs review. Keep its request ID and recover it before starting another payment."},409);}
}

/** Read saved terms without current catalog, fee configuration or mutation. */
export async function GET(req:NextRequest){
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to recover your payment option."},401);
    if(process.env.CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY!=="true")return json({error:"Saved full-payment requests are not available."},409);
    let requestId:string|null,productId:string|null;
    try{const p=req.nextUrl.searchParams;requestId=p.get("request_id");productId=p.get("product_id");
      if(p.size!==1||Boolean(requestId)===Boolean(productId))throw Error();assertAgreementId((requestId??productId)!);}
    catch{return json({error:"Invalid original request."},400);}
    if(productId){
      if(process.env.CREATOR_FULL_MANUAL_DISCOVERY_SCHEMA_READY!=="true")return json({error:"Saved full-payment discovery is not available."},409);
      const owned=await scope(user.id,productId),saved=await findFullManualCheckoutRequest({...owned,productId});
      return saved?json(await view(saved,{...owned,requestId:saved.requestId})):json({error:"Saved full-payment request not found."},404);
    }
    const owned=await scope(user.id,requestId!),saved=await readFullManualCheckoutRequest(owned);
    return saved?json(await view(saved,owned)):json({error:"Saved payment request not found."},404);
  }catch{return json({error:"Your saved full-payment request needs review."},409);}
}
