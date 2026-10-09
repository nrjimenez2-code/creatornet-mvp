import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
jest.mock("@/lib/discoverBookings",()=>({recordBookingSetup:jest.fn(async()=>({id:"attribution"})),attributedBookingUrl:(url:string)=>url}));
import { completedFreeBooking, completeFreeBooking, createFreeBooking } from "@/lib/freeBookingCheckout";
import { recordBookingSetup } from "@/lib/discoverBookings";
const base={id:"cs_test_synthetic",mode:"payment",status:"complete",payment_status:"no_payment_required",amount_total:0,currency:"usd",payment_intent:null,subscription:null,
 metadata:{kind:"free_booking_v1",free_booking_id:"free",buyer_id:"buyer",creator_id:"creator",post_id:"post",booking_redirect_url:"https://calendar.invalid/free"}} as unknown as Stripe.Checkout.Session;
const env={...process.env};
beforeEach(()=>{jest.clearAllMocks();process.env.CREATOR_PREMIUM_DELIVERY_SCHEMA_READY="true";process.env.CREATOR_PREMIUM_DELIVERY_READY="true";});
afterEach(()=>{process.env={...env};});
test.each([{status:"open"},{mode:"setup"},{payment_status:"paid"},{amount_total:1},{currency:"eur"},{payment_intent:"pi_synthetic"},{subscription:"sub_synthetic"},{metadata:{kind:"booking"}}])("rejects an invalid no-cost receipt %p",override=>{
 expect(completedFreeBooking({...base,...override} as Stripe.Checkout.Session)).toBe(false);
});
test("confirmation records attribution without purchases, earnings or scheduled bookings",async()=>{
 const row={id:"free",buyer_id:"buyer",creator_id:"creator",post_id:"post",destination:"https://calendar.invalid/free",stripe_session_id:base.id,status:"open"};
 const db=createMockClient(op=>{
  if(op.table==="free_booking_checkouts")return {data:op.kind==="select"?row:{id:"free"},error:null};
  if(op.table==="posts")return {data:{creator_id:"creator",allow_booking:true},error:null};
 });
 const result=await completeFreeBooking(db as unknown as SupabaseClient,base,"buyer");
 expect(result).toMatchObject({kind:"booking",booking_attribution_only:true,booking_redirect_url:row.destination});
 expect(recordBookingSetup).toHaveBeenCalledWith(base);
 expect(db.ops.map(op=>op.table)).toEqual(["free_booking_checkouts","posts","free_booking_checkouts"]);
});
test("another buyer cannot confirm or obtain the destination",async()=>{
 const db=createMockClient(()=>({data:{id:"free",buyer_id:"buyer",creator_id:"creator",post_id:"post",destination:"https://calendar.invalid/free",stripe_session_id:base.id},error:null}));
 await expect(completeFreeBooking(db as unknown as SupabaseClient,base,"other")).rejects.toThrow(/ownership/);expect(recordBookingSetup).not.toHaveBeenCalled();
});
test("lost creation retries use stored origin and the same idempotency key with no card requirement",async()=>{
 const row={id:"free",buyer_id:"buyer",creator_id:"creator",post_id:"post",destination:"https://calendar.invalid/free",checkout_origin:"https://saved.invalid",stripe_session_id:null,status:"creating"};
 const db=createMockClient(op=>({data:op.kind==="update"?{id:"free"}:row,error:null}));
 const create=jest.fn<Promise<{id:string;url:string}>,[Stripe.Checkout.SessionCreateParams,Stripe.RequestOptions]>(async params=>{
  if(params.payment_method_collection) throw Error("You can only set payment_method_collection if there are recurring prices.");
  return {id:base.id,url:"https://checkout.stripe.com/synthetic"};
 });
 const stripe={checkout:{sessions:{create}}} as unknown as Stripe;
 for(let i=0;i<2;i++)await createFreeBooking(db as unknown as SupabaseClient,stripe,{buyerId:"buyer",creatorId:"creator",postId:"post",destination:row.destination,site:"https://changed.invalid"});
 expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
 expect(create.mock.calls[0][0]).toMatchObject({mode:"payment",success_url:"https://saved.invalid/success?session_id={CHECKOUT_SESSION_ID}&kind=booking",line_items:[{price_data:{unit_amount:0},quantity:1}]});
 expect(create.mock.calls[0][0]).not.toHaveProperty("payment_method_collection");
 expect(create.mock.calls[0][0].payment_method_types).toBeUndefined();expect(create.mock.calls[0][1]).toEqual({idempotencyKey:"creatornet-free-booking:free"});
});
