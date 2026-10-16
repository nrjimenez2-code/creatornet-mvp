import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { isDeliveryId, readProductDelivery } from "@/lib/productDelivery";
import { premiumPostingReady, premiumSchemaReady } from "@/lib/premiumReadiness";
type Context={params:Promise<{productId:string}>};
const headers={"Cache-Control":"private, no-store"};
async function product(req:NextRequest,context:Context){
 const user=await getAuthenticatedUser(req),{productId}=await context.params;
 if(!user || !isDeliveryId(productId) || !premiumSchemaReady()) return null;
 const result=await admin.from("products").select("id,type,creator_id,delivery_revision").eq("id",productId).eq("creator_id",user.id).maybeSingle();
 if(result.error) throw Error("Product unavailable.");
 return result.data;
}
export async function GET(req:NextRequest,context:Context){
 try{
  const p=await product(req,context);
  if(!p) return NextResponse.json({error:"Product not found."},{status:404});
  if(!p.delivery_revision) return NextResponse.json({delivery:{links:[],videos:[]}},{headers});
  const [revision,videos]=await Promise.all([
   admin.from("product_delivery_revisions").select("links").eq("id",p.delivery_revision).eq("creator_id",p.creator_id).single(),
   admin.from("product_delivery_videos").select("asset_id,label").eq("revision_id",p.delivery_revision).order("position"),
  ]);
  if(revision.error || videos.error) throw Error("Delivery unavailable.");
  return NextResponse.json({delivery:{links:revision.data.links,videos:videos.data??[]}},{headers});
 }catch{return NextResponse.json({error:"Product delivery unavailable."},{status:503});}
}
export async function PUT(req:NextRequest,context:Context){
 if(!isSameOriginRequest(req)) return NextResponse.json({error:"Invalid request origin."},{status:403});
 if(!premiumPostingReady()) return NextResponse.json({error:"Product delivery editing is not enabled."},{status:409});
 try{
  const p=await product(req,context);
  if(!p) return NextResponse.json({error:"Product not found."},{status:404});
  let delivery;try{delivery=readProductDelivery(await req.json(),p.type);}catch(e){return NextResponse.json({error:publicMessage("product-delivery-input",e,"Invalid delivery.")},{status:400});}
  const result=await admin.rpc("save_product_delivery_v1",{p_product_id:p.id,p_creator_id:p.creator_id,p_links:delivery.links,p_videos:delivery.videos});
  if(result.error) return NextResponse.json({error:"Every included video must be owned by you and ready."},{status:409});
  return NextResponse.json({revision_id:result.data},{headers});
 }catch{return NextResponse.json({error:"Delivery could not be saved."},{status:503});}
}
