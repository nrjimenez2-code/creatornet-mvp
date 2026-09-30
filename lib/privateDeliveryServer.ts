import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLibraryPurchaseEligible } from "@/lib/libraryAccess";
import { membershipAccessSeconds, membershipLedgerReady } from "@/lib/membershipAccess";
import type { DeliveryLink } from "@/lib/productDelivery";
import type { PrivateAsset } from "@/lib/privateVideoProvider";
export type EntitledDelivery={purchase_id:string;product_id:string|null;post_id:string|null;title:string;type:string;links:DeliveryLink[];videos:{asset_id:string;label:string;duration_seconds:number|null;seconds:number;provider:string}[]};
export async function purchaseDeliveryAccess(admin:SupabaseClient,purchaseId:string,buyerId:string){
 const r=await admin.from("purchases").select("id,buyer_id,creator_id,product_id,post_id,status,access_granted,payment_intent_id").eq("id",purchaseId).eq("buyer_id",buyerId).maybeSingle();
 if(r.error) throw Error("Purchase access is temporarily unavailable.");
 const p=r.data;
 if(!p || !await isLibraryPurchaseEligible(admin,p,buyerId)) return null;
 const seconds=membershipLedgerReady()?await membershipAccessSeconds(admin,p.id,buyerId):900;
 return seconds>0?{purchase:p,seconds:Math.min(seconds,900)}:null;
}
/** Reads frozen deliverables for new purchases and legacy per-post delivery for old purchases. */
export async function loadPurchasedDelivery(admin:SupabaseClient,purchaseId:string,buyerId:string):Promise<EntitledDelivery|null>{
 const access=await purchaseDeliveryAccess(admin,purchaseId,buyerId);
 if(!access) return null;
 const p=access.purchase;
 const binding=await admin.from("purchase_deliveries").select("order_id").eq("purchase_id",p.id).maybeSingle();
 if(binding.error) throw Error("Purchased delivery is unavailable.");
 if(binding.data){
  const snapshot=await admin.from("checkout_delivery_snapshots").select("revision_id,title,product_type,links,buyer_id,product_id").eq("order_id",binding.data.order_id).single();
  if(snapshot.error || snapshot.data.buyer_id!==buyerId || snapshot.data.product_id!==p.product_id) throw Error("Purchased delivery binding differs.");
  const [videos,progress]=await Promise.all([
   admin.from("product_delivery_videos").select("asset_id,label,position,private_video_assets(duration_seconds,provider,status)").eq("revision_id",snapshot.data.revision_id).order("position"),
   admin.from("private_video_progress").select("asset_id,seconds").eq("purchase_id",p.id).eq("buyer_id",buyerId),
  ]);
  if(videos.error || progress.error) throw Error("Purchased videos are unavailable.");
  return {purchase_id:p.id,product_id:p.product_id,post_id:p.post_id,title:snapshot.data.title,type:snapshot.data.product_type,links:snapshot.data.links,
   videos:(videos.data??[]).map(v=>{const a=v.private_video_assets as unknown as PrivateAsset;return {asset_id:v.asset_id,label:v.label,duration_seconds:a.duration_seconds,provider:a.provider,seconds:Number(progress.data?.find(r=>r.asset_id===v.asset_id)?.seconds||0)};})};
 }
 const [prod,post,asset,progress]=await Promise.all([
  p.product_id?admin.from("products").select("title,type,deliver_url,discord_invite_url,whop_listing_url,external_url,fulfillment,discord_channel_id,whop_listing_id").eq("id",p.product_id).maybeSingle():Promise.resolve({data:null,error:null}),
  p.post_id?admin.from("posts").select("title").eq("id",p.post_id).maybeSingle():Promise.resolve({data:null,error:null}),
  p.post_id?admin.from("private_video_assets").select("id,name,duration_seconds,provider").eq("legacy_post_id",p.post_id).maybeSingle():Promise.resolve({data:null,error:null}),
  admin.from("private_video_progress").select("asset_id,seconds").eq("purchase_id",p.id).eq("buyer_id",buyerId),
 ]);
 if(prod.error || post.error || asset.error || progress.error) throw Error("Legacy delivery is unavailable.");
 const links:DeliveryLink[]=[];
 for(const [label,url] of [["Content",prod.data?.deliver_url],["Discord",prod.data?.discord_invite_url||(prod.data?.fulfillment==="DISCORD"?prod.data.discord_channel_id:null)],["Whop",prod.data?.whop_listing_url||(prod.data?.fulfillment==="WHOP"?prod.data.whop_listing_id:null)],["Access",prod.data?.external_url]]){
  if(typeof url==="string" && url.startsWith("https://")) links.push({label:label as string,url});
 }
 return {purchase_id:p.id,product_id:p.product_id,post_id:p.post_id,title:prod.data?.title||post.data?.title||"Purchased product",type:prod.data?.type||"video",links,
  videos:asset.data?[{asset_id:asset.data.id,label:asset.data.name,provider:asset.data.provider,duration_seconds:asset.data.duration_seconds,seconds:Number(progress.data?.find(v=>v.asset_id===asset.data?.id)?.seconds||0)}]:[]};
}
export async function entitledVideo(admin:SupabaseClient,assetId:string,userId:string,purchaseId?:string){
 const result=await admin.from("private_video_assets").select("id,creator_id,provider,provider_id,status,duration_seconds,legacy_post_id").eq("id",assetId).maybeSingle();
 if(result.error) throw Error("Video access is unavailable.");
 const asset=result.data as (PrivateAsset&{legacy_post_id:string|null})|null;
 if(!asset || asset.status!=="ready" || !asset.provider_id) return null;
 if(asset.creator_id===userId && !purchaseId) return {asset,seconds:900};
 if(!purchaseId) return null;
 const delivery=await loadPurchasedDelivery(admin,purchaseId,userId);
 if(!delivery?.videos.some(v=>v.asset_id===assetId)) return null;
 const access=await purchaseDeliveryAccess(admin,purchaseId,userId);
 return access?{asset,seconds:access.seconds}:null;
}
