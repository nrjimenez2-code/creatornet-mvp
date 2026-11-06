import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "@/lib/installments/contextRuntime";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",Vary:"Cookie, Authorization","Referrer-Policy":"no-referrer"}});
export async function GET(req:NextRequest){
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to recover your payment."},401);
    if(process.env.CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY!=="true")return json({error:"Payment recovery is unavailable."},409);
    const params=req.nextUrl.searchParams,attemptId=params.get("attempt_id");
    try{assertAgreementId(attemptId!);if(params.size!==1||params.getAll("attempt_id").length!==1)throw Error();}catch{return json({error:"Invalid original payment."},400);}
    const config=exactContextServerConfig(),observation=await createExactContextRuntime(config).observeContext();assertFreshExactRuntimeContextObservation(observation);
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const protocol=await admin.from("server_payment_protocols_v1").select("attempt_id,kind,reservation_id")
      .eq("attempt_id",attemptId).eq("buyer_id",user.id).contains("context",config.approvedContext).maybeSingle();
    if(protocol.error)throw Error();if(!protocol.data)return json({error:"Original payment not found."},404);
    const mode=protocol.data.kind==="full"?"full":protocol.data.kind==="first_installment"?"installments":null;if(!mode)throw Error();
    let query=admin.from(mode==="full"?"full_manual_checkout_requests_v1":"buyer_mentorship_installment_reservations_v1")
      .select("request_id").eq("attempt_id",attemptId).eq("buyer_id",user.id).contains("context",config.approvedContext);
    if(mode==="installments")query=query.eq("id",protocol.data.reservation_id);
    const result=await query.maybeSingle();if(result.error||!result.data)throw Error();assertAgreementId(result.data.request_id);
    return json({requestId:result.data.request_id,mode});
  }catch{return json({error:"Your original payment needs recovery review."},409);}
}
