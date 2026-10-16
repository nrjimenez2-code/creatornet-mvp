import type Stripe from "stripe";
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock("@/lib/discoverServer",()=>({discoverEnabled:()=>true,recordDiscoverEvent:jest.fn(async()=>undefined)}));
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordDiscoverEvent } from "@/lib/discoverServer";
import { recordBookingSetup } from "@/lib/discoverBookings";
const base={id:"cs_test_zero",mode:"payment",status:"complete",payment_status:"paid",amount_total:0,currency:"usd",payment_intent:null,subscription:null,
 metadata:{kind:"free_booking_v1",buyer_id:"buyer",post_id:"post",creator_id:"creator"}} as unknown as Stripe.Checkout.Session;
const posts={select:jest.fn(),eq:jest.fn(),single:jest.fn()};
const attribution={upsert:jest.fn(),select:jest.fn(),eq:jest.fn(),single:jest.fn()};
beforeEach(()=>{
 jest.clearAllMocks();
 posts.select.mockReturnValue(posts);posts.eq.mockReturnValue(posts);posts.single.mockResolvedValue({data:{creator_id:"creator"},error:null});
 attribution.upsert.mockResolvedValue({error:null});attribution.select.mockReturnValue(attribution);attribution.eq.mockReturnValue(attribution);attribution.single.mockResolvedValue({data:{id:"attribution"},error:null});
 (supabaseAdmin.from as jest.Mock).mockImplementation(table=>{if(table==="posts")return posts;if(table==="discover_booking_attribution_v1")return attribution;throw Error("Unexpected table: "+table);});
});
test.each(["paid","no_payment_required"] as const)("%s zero-total completion records only the existing attribution",async payment_status=>{
 expect(await recordBookingSetup({...base,payment_status})).toBe("attribution");
 expect(attribution.upsert).toHaveBeenCalledWith({setup_session_id:base.id,user_id:"buyer",creator_id:"creator",post_id:"post"},{onConflict:"setup_session_id",ignoreDuplicates:true});
 expect(recordDiscoverEvent).toHaveBeenCalledWith({actor:"user:buyer",userId:"buyer",postId:"post",kind:"booking_setup_complete",entityKey:base.id});
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
 expect(await recordBookingSetup({...base,mode:"setup",amount_total:null,currency:null,metadata:{...base.metadata,kind:"booking"}})).toBe("attribution");
 expect(attribution.upsert).toHaveBeenCalledTimes(1);
});
test("wrong creator cannot record zero-cost attribution",async()=>{
 posts.single.mockResolvedValue({data:{creator_id:"other"},error:null});
 await expect(recordBookingSetup(base)).rejects.toThrow("Booking source mismatch");
 expect(attribution.upsert).not.toHaveBeenCalled();
});
