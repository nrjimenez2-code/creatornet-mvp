import type {SupabaseClient} from "@supabase/supabase-js";
import {membershipAccessSeconds,membershipLedgerReady} from "@/lib/membershipAccess";
import {loadPurchasedDelivery} from "@/lib/privateDeliveryServer";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const env={...process.env},rpc=jest.fn();
beforeEach(()=>{
 jest.clearAllMocks();for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY"])process.env[key]="true";
 for(const key of ["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY","CREATOR_FIXED_SERVICE_SCHEMA_READY","CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY"])delete process.env[key];
 rpc.mockResolvedValue({data:{applicable:true,allowed:true,maxAgeSeconds:17},error:null});
});afterEach(()=>{process.env={...env};});
test("team timed access uses the shared reader with new fulfillment admission disabled",async()=>{
 expect(membershipLedgerReady()).toBe(true);expect(await membershipAccessSeconds({rpc} as unknown as SupabaseClient,"purchase","buyer")).toBe(17);
 expect(rpc).toHaveBeenCalledWith("read_sales_team_entitlement_v1",{p_purchase_id:"purchase",p_buyer_id:"buyer"});
});
test.each([{applicable:true,allowed:false,maxAgeSeconds:0},{applicable:true,allowed:true,maxAgeSeconds:3601},null])("denied or malformed team entitlement %p never falls through to permanent access",async data=>{
 process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY="true";rpc.mockResolvedValue({data,error:null});expect(await membershipAccessSeconds({rpc} as unknown as SupabaseClient,"purchase","buyer")).toBe(0);expect(rpc).toHaveBeenCalledTimes(1);
});
test("the reader preserves legacy access and the existing monthly-reader fallback",async()=>{
 rpc.mockResolvedValue({data:{applicable:false,allowed:true,maxAgeSeconds:3600},error:null});expect(await membershipAccessSeconds({rpc} as unknown as SupabaseClient,"legacy","buyer")).toBe(3600);
 process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY="true";rpc.mockResolvedValueOnce({data:{applicable:false,allowed:false,maxAgeSeconds:0},error:null}).mockResolvedValueOnce({data:{allowed:true,maxAgeSeconds:31},error:null});
 expect(await membershipAccessSeconds({rpc} as unknown as SupabaseClient,"monthly","buyer")).toBe(31);
 expect(rpc).toHaveBeenLastCalledWith("read_monthly_mentorship_entitlement_v1",{p_purchase_id:"monthly",p_buyer_id:"buyer"});
});
test("verified team access unlocks the same frozen Library delivery snapshot",async()=>{
 const db=createMockClient(op=>{
  if(op.table==="purchases")return {data:{id:"purchase",buyer_id:"buyer",creator_id:"creator",product_id:"product",post_id:"post",status:"active",access_granted:false,payment_intent_id:"pi_original"},error:null};
  if(op.table==="payment_dispute_state")return {data:null,error:null};
  if(op.table==="purchase_deliveries")return {data:{order_id:"original-order"},error:null};
  if(op.table==="checkout_delivery_snapshots")return {data:{buyer_id:"buyer",product_id:"product",revision_id:"original-revision",title:"Accepted offer",product_type:"course",links:[{label:"Course",url:"https://fixture.invalid/original"}]},error:null};
  if(op.table==="product_delivery_videos"||op.table==="private_video_progress")return {data:[],error:null};
 });db.rpc=rpc;
 expect(await loadPurchasedDelivery(db as unknown as SupabaseClient,"purchase","buyer")).toMatchObject({title:"Accepted offer",links:[{url:"https://fixture.invalid/original"}]});
 rpc.mockResolvedValue({data:{applicable:true,allowed:false,maxAgeSeconds:0},error:null});expect(await loadPurchasedDelivery(db as unknown as SupabaseClient,"purchase","buyer")).toBeNull();
});
