import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { loadPurchasedDelivery, entitledVideo } from "@/lib/privateDeliveryServer";
let purchase:Record<string,unknown>|null,dispute:Record<string,unknown>|null;
const saved={...process.env},buyer="buyer",id="purchase",asset="asset";
beforeEach(()=>{
 delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
 purchase={id,buyer_id:buyer,creator_id:"creator",product_id:"product",post_id:"post",status:"paid",access_granted:true,payment_intent_id:"pi_test"};
 dispute=null;
});
afterEach(()=>{process.env={...saved};});
function client(){
 return createMockClient(op=>{
  if(op.table==="purchases")return {data:purchase,error:null};
  if(op.table==="payment_dispute_state")return {data:dispute,error:null};
  if(op.table==="purchase_deliveries")return {data:{order_id:"frozen-order"},error:null};
  if(op.table==="checkout_delivery_snapshots")return {data:{revision_id:"frozen-revision",buyer_id:buyer,product_id:"product",title:"Purchased bundle",product_type:"bundle",links:[{label:"Access",url:"https://private.invalid/access"}]},error:null};
  if(op.table==="product_delivery_videos")return {data:[{asset_id:asset,label:"Purchased lesson",position:0,private_video_assets:{duration_seconds:3600,provider:"stream",status:"ready"}}],error:null};
  if(op.table==="private_video_progress")return {data:[{asset_id:asset,seconds:312}],error:null};
  if(op.table==="private_video_assets")return {data:{id:asset,creator_id:"creator",provider:"stream",provider_id:"a".repeat(32),status:"ready",duration_seconds:3600},error:null};
 });
}
test("reads purchased revision and private progress rather than the edited product or public promo",async()=>{
 const db=client(),delivery=await loadPurchasedDelivery(db as unknown as SupabaseClient,id,buyer);
 expect(delivery).toMatchObject({title:"Purchased bundle",videos:[{asset_id:asset,label:"Purchased lesson",seconds:312}]});
 expect(db.ops.some(op=>op.table==="products" || op.table==="posts")).toBe(false);
 expect(db.opsFor("product_delivery_videos")[0].filters).toEqual({revision_id:"frozen-revision"});
 expect(JSON.stringify(delivery)).not.toContain("provider_id");expect(JSON.stringify(delivery)).not.toContain("manifest");
});
test.each(["pending","processing","refunded","canceled","failed"])("%s cannot unlock URLs or videos",async status=>{
 purchase!.status=status;const db=client();
 expect(await loadPurchasedDelivery(db as unknown as SupabaseClient,id,buyer)).toBeNull();
 expect(db.opsFor("checkout_delivery_snapshots")).toHaveLength(0);
});
test("another buyer cannot obtain the delivery even with a known purchase identity",async()=>{
 const db=client();expect(await loadPurchasedDelivery(db as unknown as SupabaseClient,id,"other")).toBeNull();
 expect(db.opsFor("checkout_delivery_snapshots")).toHaveLength(0);
});
test.each(["needs_response","under_review","lost","won","warning_closed"])("dispute %s uses the existing recovered-access rules",async status=>{
 dispute={stripe_dispute_id:"dp_test",stripe_payment_intent_id:"pi_test",stripe_charge_id:"ch_test",disputed_amount_cents:5000,currency:"usd",status,stripe_event_created:1};
 const result=await loadPurchasedDelivery(client() as unknown as SupabaseClient,id,buyer);
 expect(Boolean(result)).toBe(["won","warning_closed"].includes(status));
});
test("turning off new posting keeps completed purchase delivery available",async()=>{
 process.env.CREATOR_PREMIUM_DELIVERY_SCHEMA_READY="true";process.env.CREATOR_PREMIUM_DELIVERY_READY="false";
 expect(await loadPurchasedDelivery(client() as unknown as SupabaseClient,id,buyer)).not.toBeNull();
});
test("expired membership access fails closed before delivery reads",async()=>{
 process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY="true";purchase!.access_granted=false;
 expect(await loadPurchasedDelivery(client() as unknown as SupabaseClient,id,buyer)).toBeNull();
});
test("creator preview is private and does not give a different user access",async()=>{
 const db=client();expect(await entitledVideo(db as unknown as SupabaseClient,asset,"creator")).toMatchObject({seconds:900});
 expect(await entitledVideo(db as unknown as SupabaseClient,asset,"other")).toBeNull();
});
test.each(["DISCORD","WHOP"])("legacy %s link fields remain available only to the entitled buyer",async fulfillment=>{
 purchase!.post_id=null;
 const db=createMockClient(op=>{
  if(op.table==="purchases")return {data:purchase,error:null};
  if(op.table==="products")return {data:{title:"Legacy link product",type:"course",fulfillment,discord_channel_id:"https://discord.gg/owned",whop_listing_id:"https://whop.com/owned"},error:null};
  if(op.table==="private_video_progress")return {data:[],error:null};
  return {data:null,error:null};
 });
 const result=await loadPurchasedDelivery(db as unknown as SupabaseClient,id,buyer);
 expect(result?.links).toEqual([{label:fulfillment==="DISCORD"?"Discord":"Whop",url:fulfillment==="DISCORD"?"https://discord.gg/owned":"https://whop.com/owned"}]);
 expect(db.opsFor("posts")).toHaveLength(0);
 expect(await loadPurchasedDelivery(db as unknown as SupabaseClient,id,"other")).toBeNull();
});
