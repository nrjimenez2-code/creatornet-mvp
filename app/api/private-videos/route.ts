import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { publicMessage } from "@/lib/apiError";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { allowRequest, tooManyRequests } from "@/lib/rateLimit";
import { premiumPostingReady, premiumSchemaReady } from "@/lib/premiumReadiness";
import { readPremiumUpload } from "@/lib/productDelivery";
import { createPrivateStreamUpload, PrivateUploadRejected } from "@/lib/privateVideoProvider";
export const runtime="nodejs";
export const maxDuration=60;
const headers={"Cache-Control":"private, no-store"};
export async function GET(req:NextRequest){
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401});
 if(!premiumSchemaReady()) return NextResponse.json({items:[]},{headers});
 const result=await admin.from("private_video_assets").select("id,name,status,duration_seconds,fingerprint,size_bytes,upload_expires_at,failure_code").eq("creator_id",user.id).order("created_at",{ascending:false}).limit(100);
 return result.error?NextResponse.json({error:"Videos unavailable."},{status:503,headers}):NextResponse.json({items:result.data??[]},{headers});
}
export async function POST(req:NextRequest){
 if(!isSameOriginRequest(req)) return NextResponse.json({error:"Invalid request origin."},{status:403});
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401});
 if(!premiumPostingReady()) return NextResponse.json({error:"Private uploads are not enabled yet."},{status:409});
 if(!allowRequest("premium-upload:"+user.id,{limit:20,windowMs:60000})) return tooManyRequests();
 const profile=await admin.from("profiles").select("banned_at").eq("id",user.id).maybeSingle();
 if(profile.error || !profile.data || profile.data.banned_at) return NextResponse.json({error:"Uploads unavailable for this account."},{status:403});
 let input:ReturnType<typeof readPremiumUpload>;
 try{input=readPremiumUpload(await req.json());}catch(e){return NextResponse.json({error:publicMessage("private-video-input",e,"Invalid video.")},{status:400});}
 const existing=await admin.from("private_video_assets").select("id,status,size_bytes,upload_url,upload_expires_at").eq("creator_id",user.id).eq("fingerprint",input.fingerprint).not("status","in","(failed,canceled)").maybeSingle();
 if(existing.error) return NextResponse.json({error:"Upload recovery unavailable."},{status:503});
 if(existing.data){
  if(Number(existing.data.size_bytes)!==input.size) return NextResponse.json({error:"Reselect the original file."},{status:409});
  if(existing.data.status==="canceling") return NextResponse.json({error:"Finish canceling this upload before retrying."},{status:409,headers});
  return NextResponse.json({asset_id:existing.data.id,status:existing.data.status,upload_url:existing.data.upload_url,expires_at:existing.data.upload_expires_at},{status:existing.data.status==="creating"?202:200,headers});
 }
 const assetId=randomUUID(),expiresAt=new Date(Date.now()+6*3600000).toISOString();
 const claim=await admin.from("private_video_assets").insert({id:assetId,creator_id:user.id,provider:"stream",status:"creating",name:input.name,
  size_bytes:input.size,duration_seconds:input.duration,fingerprint:input.fingerprint,upload_expires_at:expiresAt});
 if(claim.error) return NextResponse.json({error:"An upload may already be starting. Retry to recover it."},{status:409});
 try{
  const upload=await createPrivateStreamUpload({assetId,creatorId:user.id,size:input.size,duration:input.duration,expiresAt});
  const saved=await admin.from("private_video_assets").update({provider_id:upload.uid,upload_url:upload.url,status:"uploading",updated_at:new Date().toISOString()}).eq("id",assetId).eq("status","creating").select("id").maybeSingle();
  if(saved.error || !saved.data) throw Error("Upload binding unavailable.");
  return NextResponse.json({asset_id:assetId,status:"uploading",upload_url:upload.url,expires_at:expiresAt},{headers});
 }catch(error){
  if(error instanceof PrivateUploadRejected){
   const failed=await admin.from("private_video_assets").update({status:"failed",failure_code:"upload_declined"}).eq("id",assetId).eq("status","creating");
   if(!failed.error) return NextResponse.json({asset_id:assetId,status:"failed",error:"The provider declined this upload. Check capacity and configuration before retrying."},{status:409,headers});
  }
  // The provider may have created the upload. Preserve this identity; never
  // silently create another reservation after an ambiguous response.
  return NextResponse.json({asset_id:assetId,status:"creating",error:"Upload creation needs recovery. No replacement was created."},{status:202,headers});
 }
}
