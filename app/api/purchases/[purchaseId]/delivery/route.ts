import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isDeliveryId } from "@/lib/productDelivery";
import { loadPurchasedDelivery } from "@/lib/privateDeliveryServer";
export const runtime="nodejs";
export async function GET(req:NextRequest,{params}:{params:Promise<{purchaseId:string}>}){
 const user=await getAuthenticatedUser(req);
 if(!user) return NextResponse.json({error:"Sign in required."},{status:401});
 const {purchaseId}=await params;
 if(!isDeliveryId(purchaseId)) return NextResponse.json({error:"Invalid purchase."},{status:400});
 try{
  const delivery=await loadPurchasedDelivery(admin,purchaseId,user.id);
  return delivery?NextResponse.json({delivery},{headers:{"Cache-Control":"private, no-store"}}):NextResponse.json({error:"No current purchased access."},{status:403});
 }catch{return NextResponse.json({error:"Delivery is temporarily unavailable."},{status:503});}
}
