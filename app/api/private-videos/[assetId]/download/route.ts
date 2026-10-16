import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { entitledVideo } from "@/lib/privateDeliveryServer";
import { isDeliveryId } from "@/lib/productDelivery";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { privateStreamDownload, signPrivateStreamPlayback } from "@/lib/privateVideoProvider";
import { isOwnPremiumPath } from "@/lib/premiumPath";
import { allowRequest, tooManyRequests } from "@/lib/rateLimit";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store"};
type Context={params:Promise<{assetId:string}>};
async function download(req:NextRequest,context:Context,create:boolean){
 if(create && !isSameOriginRequest(req)) return NextResponse.json({error:"Invalid request origin."},{status:403,headers});
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401,headers});
 const {assetId}=await context.params,purchaseId=req.nextUrl.searchParams.get("purchase_id")??undefined;
 if(!isDeliveryId(assetId) || !purchaseId || !isDeliveryId(purchaseId)) return NextResponse.json({error:"Invalid purchase or video."},{status:400,headers});
 if(!allowRequest("premium-download:"+user.id,{limit:30,windowMs:60000})) return tooManyRequests();
 try{
  const access=await entitledVideo(admin,assetId,user.id,purchaseId);
  if(!access) return NextResponse.json({error:"No current purchased access."},{status:403,headers});
  if(access.asset.provider==="stream"){
   const result=await privateStreamDownload(access.asset.provider_id!,create);
   return NextResponse.json({...result,...(result.status==="ready"?{download_url:signPrivateStreamPlayback(access.asset.provider_id!,access.seconds,true).download_url}:{})},{status:result.status==="ready"?200:202,headers});
  }
  if(!isOwnPremiumPath(access.asset.provider_id,access.asset.creator_id)) return NextResponse.json({error:"Invalid legacy asset."},{status:403,headers});
  const result=await admin.storage.from("premium").createSignedUrl(access.asset.provider_id!,access.seconds,{download:true});
  if(result.error || !result.data?.signedUrl) throw Error("Legacy download unavailable.");
  return NextResponse.json({status:"ready",download_url:result.data.signedUrl},{headers});
 }catch{return NextResponse.json({error:"Download is temporarily unavailable."},{status:503,headers});}
}
export const GET=(req:NextRequest,context:Context)=>download(req,context,false);
export const POST=(req:NextRequest,context:Context)=>download(req,context,true);
