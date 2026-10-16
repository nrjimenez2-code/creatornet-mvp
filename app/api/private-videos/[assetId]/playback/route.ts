import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isDeliveryId } from "@/lib/productDelivery";
import { entitledVideo } from "@/lib/privateDeliveryServer";
import { signPrivateStreamPlayback } from "@/lib/privateVideoProvider";
import { isOwnPremiumPath } from "@/lib/premiumPath";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store"};
export async function GET(req:NextRequest,{params}:{params:Promise<{assetId:string}>}){
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401,headers});
 const {assetId}=await params,purchaseId=req.nextUrl.searchParams.get("purchase_id")??undefined;
 if(!isDeliveryId(assetId) || purchaseId && !isDeliveryId(purchaseId)) return NextResponse.json({error:"Invalid video."},{status:400,headers});
 try{
  const access=await entitledVideo(admin,assetId,user.id,purchaseId);
  if(!access) return NextResponse.json({error:"No current purchased access."},{status:403,headers});
  if(access.asset.provider==="stream") return NextResponse.json(signPrivateStreamPlayback(access.asset.provider_id!,access.seconds),{headers});
  if(!isOwnPremiumPath(access.asset.provider_id,access.asset.creator_id)) return NextResponse.json({error:"Invalid legacy asset."},{status:403,headers});
  const result=await admin.storage.from("premium").createSignedUrl(access.asset.provider_id!,access.seconds);
  if(result.error || !result.data?.signedUrl) throw Error("Legacy playback unavailable.");
  return NextResponse.json({url:result.data.signedUrl,download_url:result.data.signedUrl,expires_at:new Date(Date.now()+access.seconds*1000).toISOString()},{headers});
 }catch{return NextResponse.json({error:"Private playback is temporarily unavailable."},{status:503,headers});}
}
