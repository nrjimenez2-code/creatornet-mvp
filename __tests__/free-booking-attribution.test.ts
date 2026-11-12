import type Stripe from "stripe";
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{from:jest.fn(),rpc:jest.fn(async()=>({data:{state:"legacy"},error:null}))}}));
jest.mock("@/lib/discoverServer",()=>({discoverEnabled:()=>true,recordDiscoverEvent:jest.fn(async()=>undefined)}));
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordDiscoverEvent } from "@/lib/discoverServer";
import { recordBookingSetup } from "@/lib/discoverBookings";
const base={id:"cs_test_zero",mode:"payment",status:"complete",payment_status:"paid",amount_total:0,currency:"usd",payment_intent:null,subscription:null,
 metadata:{kind:"free_booking_v1",buyer_id:"00000000-0000-4000-8000-000000000010",post_id:"00000000-0000-4000-8000-000000000020",creator_id:"00000000-0000-4000-8000-000000000001"}} as unknown as Stripe.Checkout.Session;
const posts={select:jest.fn(),eq:jest.fn(),single:jest.fn()};
const attribution={upsert:jest.fn(),select:jest.fn(),eq:jest.fn(),single:jest.fn()};
const env={...process.env};
beforeEach(()=>{
 jest.clearAllMocks();
 posts.select.mockReturnValue(posts);posts.eq.mockReturnValue(posts);posts.single.mockResolvedValue({data:{creator_id:"00000000-0000-4000-8000-000000000001"},error:null});
 attribution.upsert.mockResolvedValue({error:null});attribution.select.mockReturnValue(attribution);attribution.eq.mockReturnValue(attribution);attribution.single.mockResolvedValue({data:{id:"00000000-0000-4000-8000-000000000026"},error:null});
 (supabaseAdmin.from as jest.Mock).mockImplementation(table=>{if(table==="posts")return posts;if(table==="discover_booking_attribution_v1")return attribution;throw Error("Unexpected table: "+table);});
});
afterEach(()=>{process.env={...env};});
test.each(["paid","no_payment_required"] as const)("%s zero-total completion records only the existing attribution",async payment_status=>{
 expect(await recordBookingSetup({...base,payment_status})).toBe("00000000-0000-4000-8000-000000000026");
 expect(attribution.upsert).toHaveBeenCalledWith({setup_session_id:base.id,user_id:"00000000-0000-4000-8000-000000000010",creator_id:"00000000-0000-4000-8000-000000000001",post_id:"00000000-0000-4000-8000-000000000020"},{onConflict:"setup_session_id",ignoreDuplicates:true});
 expect(recordDiscoverEvent).toHaveBeenCalledWith({actor:"user:00000000-0000-4000-8000-000000000010",userId:"00000000-0000-4000-8000-000000000010",postId:"00000000-0000-4000-8000-000000000020",kind:"booking_setup_complete",entityKey:base.id});
 expect((supabaseAdmin.from as jest.Mock).mock.calls.map(([table])=>table)).toEqual(["posts","discover_booking_attribution_v1","discover_booking_attribution_v1"]);
});
test.each([
 {payment_status:"unpaid"},{amount_total:1},{payment_intent:"pi_synthetic"},
 {payment_status:"no_payment_required",currency:"eur"},{payment_status:"no_payment_required",subscription:"sub_synthetic"},
 {status:"open"},{metadata:{...base.metadata,kind:"other"}},
])("invalid zero-cost receipt cannot create attribution %p",async override=>{
 expect(await recordBookingSetup({...base,...override} as Stripe.Checkout.Session)).toBeNull();
 expect(supabaseAdmin.from).not.toHaveBeenCalled();expect(recordDiscoverEvent).not.toHaveBeenCalled();
});
test("completed legacy setup-mode booking still records attribution",async()=>{
 expect(await recordBookingSetup({...base,mode:"setup",amount_total:null,currency:null,metadata:{...base.metadata,kind:"booking"}})).toBe("00000000-0000-4000-8000-000000000026");
 expect(attribution.upsert).toHaveBeenCalledTimes(1);
});
test("wrong creator cannot record zero-cost attribution",async()=>{
 posts.single.mockResolvedValue({data:{creator_id:"other"},error:null});
 await expect(recordBookingSetup(base)).rejects.toThrow("Booking source mismatch");
 expect(attribution.upsert).not.toHaveBeenCalled();
});
test('an enrolled kind-less setup remains held instead of acknowledging an unrecorded original team obligation',async()=>{
 process.env.CREATOR_SALES_TEAM_SCHEMA_READY='true';
 const settings={select:jest.fn(),eq:jest.fn(),maybeSingle:jest.fn(async()=>({data:{routing_enabled:true},error:null}))};
 settings.select.mockReturnValue(settings);settings.eq.mockReturnValue(settings);
 const owner={select:jest.fn(),eq:jest.fn(),maybeSingle:jest.fn(async()=>({data:{creator_id:'00000000-0000-4000-8000-000000000001'},error:null}))};
 owner.select.mockReturnValue(owner);owner.eq.mockReturnValue(owner);
 (supabaseAdmin.from as jest.Mock).mockImplementation(table=>{if(table==='sales_team_creator_settings_v1')return settings;if(table==='posts')return owner;throw Error('Unexpected write/read: '+table);});
 const session={...base,mode:'setup',metadata:{creatorId:'00000000-0000-4000-8000-000000000001',postId:'00000000-0000-4000-8000-000000000020',buyer_id:'00000000-0000-4000-8000-000000000010'}} as unknown as Stripe.Checkout.Session;
 await expect(recordBookingSetup(session)).rejects.toThrow('original booking setup needs review');
 expect(attribution.upsert).not.toHaveBeenCalled();expect(recordDiscoverEvent).not.toHaveBeenCalled();
});
test('unrelated setup traffic without booking markers remains outside historical booking classification',async()=>{
 process.env.CREATOR_SALES_TEAM_SCHEMA_READY='true';
 expect(await recordBookingSetup({...base,mode:'setup',metadata:{kind:'unrelated_saved_method'}})).toBeNull();
 expect(supabaseAdmin.from).not.toHaveBeenCalled();expect(attribution.upsert).not.toHaveBeenCalled();
});
