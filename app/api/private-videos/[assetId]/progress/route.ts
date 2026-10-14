import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { isDeliveryId, PREMIUM_MAX_SECONDS } from "@/lib/productDelivery";
import { entitledVideo } from "@/lib/privateDeliveryServer";
export const runtime="nodejs";
export async function PUT(req:NextRequest,{params}:{params:Promise<{assetId:string}>}){
 if(!isSameOriginRequest(req)) return NextResponse.json({error:"Invalid request origin."},{status:403});
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401});
 const {assetId}=await params,body=await req.json().catch(()=>null);
 if(!isDeliveryId(assetId) || !isDeliveryId(body?.purchase_id) || typeof body?.seconds!=="number" || !Number.isFinite(body.seconds) || body.seconds<0 || body.seconds>PREMIUM_MAX_SECONDS) return NextResponse.json({error:"Invalid progress."},{status:400});
 try{
  const access=await entitledVideo(admin,assetId,user.id,body.purchase_id);
  if(!access) return NextResponse.json({error:"No current purchased access."},{status:403});
  const seconds=Math.min(body.seconds,Number(access.asset.duration_seconds)||PREMIUM_MAX_SECONDS);
  const result=await admin.from("private_video_progress").upsert({purchase_id:body.purchase_id,asset_id:assetId,buyer_id:user.id,seconds,updated_at:new Date().toISOString()},{onConflict:"purchase_id,asset_id"});
  if(result.error) throw Error("Progress unavailable.");
  return NextResponse.json({ok:true},{headers:{"Cache-Control":"private, no-store"}});
 }catch{return NextResponse.json({error:"Progress could not be saved."},{status:503});}
}
