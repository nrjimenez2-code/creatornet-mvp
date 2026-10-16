import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { isDeliveryId } from "@/lib/productDelivery";
import { privateStreamStatus, cancelPrivateStreamUpload, recoverPrivateStreamUpload, PrivateVideoGone } from "@/lib/privateVideoProvider";
import { premiumSchemaReady } from "@/lib/premiumReadiness";
export const runtime="nodejs";
type Context={params:Promise<{assetId:string}>};
const headers={"Cache-Control":"private, no-store"};
async function owned(req:NextRequest,context:Context){
 const user=await getAuthenticatedUser(req),{assetId}=await context.params;
 if(!user || !isDeliveryId(assetId) || !premiumSchemaReady()) return null;
 const result=await admin.from("private_video_assets").select("id,creator_id,provider,provider_id,status,duration_seconds,upload_url,upload_expires_at,failure_code").eq("id",assetId).eq("creator_id",user.id).maybeSingle();
 if(result.error) throw Error("Upload status unavailable.");
 return result.data;
}
export async function GET(req:NextRequest,context:Context){
 try{
  const asset=await owned(req,context);
  if(!asset) return NextResponse.json({error:"Video not found."},{status:404,headers});
  let status=asset.status,duration=asset.duration_seconds,failure=asset.failure_code;
  if(asset.provider==="stream" && status==="creating" && !asset.provider_id){
   const recovered=await recoverPrivateStreamUpload(asset.id,asset.creator_id);
   if(recovered){
    asset.provider_id=recovered.uid;
    const saved=await admin.from("private_video_assets").update({provider_id:recovered.uid,status:recovered.status.status,duration_seconds:recovered.status.duration??duration,
     failure_code:recovered.status.status==="uploading"?"upload_url_recovery_required":recovered.status.failure,updated_at:new Date().toISOString()})
     .eq("id",asset.id).eq("status","creating").select("id").maybeSingle();
    if(saved.error || !saved.data) throw Error("Upload reconciliation could not be saved.");
    asset.status=recovered.status.status;status=asset.status;failure=recovered.status.status==="uploading"?"upload_url_recovery_required":recovered.status.failure;
   }else if(asset.upload_expires_at && Date.parse(asset.upload_expires_at)<Date.now()){
    const expired=await admin.from("private_video_assets").update({status:"failed",failure_code:"creation_expired"}).eq("id",asset.id).eq("status","creating");
    if(expired.error) throw Error("Upload expiry unavailable.");
    status="failed";failure="creation_expired";
   }
  }
  if(asset.provider==="stream" && asset.provider_id && !["ready","failed","canceling","canceled"].includes(status)){
   try {
    const current=await privateStreamStatus(asset.provider_id);
    status=current.status;duration=current.duration??duration;failure=current.failure;
   } catch(e) {
    // A confirmed missing resource is terminal. Transient provider failures
    // preserve the same upload claim so that Retry cannot duplicate it.
    if(!(e instanceof PrivateVideoGone)) throw e;
    status="failed";failure="provider_video_missing";
   }
   if(status==="uploading" && asset.upload_expires_at && Date.parse(asset.upload_expires_at)<Date.now()){status="failed";failure="upload_expired";}
   const saved=await admin.from("private_video_assets").update({status,duration_seconds:duration,failure_code:failure,updated_at:new Date().toISOString()}).eq("id",asset.id).eq("status",asset.status).select("id").maybeSingle();
   if(saved.error) throw Error("Status could not be saved.");
   if(!saved.data) return NextResponse.json({error:"Status changed; refresh."},{status:409,headers});
  }
  return NextResponse.json({asset_id:asset.id,status,duration_seconds:duration,failure_code:failure,
   ...(status==="uploading"?{upload_url:asset.upload_url,expires_at:asset.upload_expires_at}:{})},{headers});
 }catch{return NextResponse.json({error:"Video status is temporarily unavailable."},{status:503,headers});}
}
export async function DELETE(req:NextRequest,context:Context){
 if(!isSameOriginRequest(req)) return NextResponse.json({error:"Invalid request origin."},{status:403});
 try{
  const asset=await owned(req,context);
  if(!asset) return NextResponse.json({error:"Video not found."},{status:404});
  // Unknown creations need provider reconciliation before cancellation;
  // allowing replacement here could lose an existing reserved upload.
  if(asset.status==="creating") return NextResponse.json({error:"Resolve upload creation before canceling."},{status:409});
  if(asset.status==="ready") return NextResponse.json({error:"A ready video may be included in products; remove it from the draft instead."},{status:409});
  if(asset.status==="canceled") return NextResponse.json({status:"canceled"},{headers});
  const updated=await admin.from("private_video_assets").update({status:"canceling",updated_at:new Date().toISOString()}).eq("id",asset.id).in("status",["uploading","processing","failed","canceling"]).select("id").maybeSingle();
  if(updated.error || !updated.data) return NextResponse.json({error:"Video changed. Refresh before canceling."},{status:409});
  if(asset.provider==="stream" && asset.provider_id) await cancelPrivateStreamUpload(asset.provider_id);
  const finished=await admin.from("private_video_assets").update({status:"canceled",updated_at:new Date().toISOString()}).eq("id",asset.id).eq("status","canceling");
  if(finished.error) throw Error("Cancellation binding requires recovery.");
  return NextResponse.json({status:"canceled"},{headers});
 }catch{return NextResponse.json({error:"Upload cancellation needs recovery."},{status:503,headers});}
}
