import {NextRequest} from "next/server";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let mockUser:any,mockActive:any,mockArchive:any,mockError:any;
const mockStop=jest.fn(),mockDb=createMockClient(op=>({data:op.table==="product_checkout_attempts"?mockActive:mockArchive,error:mockError}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:async()=>mockUser}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:{siteOrigin:"https://fixture.invalid"},configuredSupabaseUrl:"https://fixture.supabase.co",supabaseServiceKey:"fixture"})}));
jest.mock("@/lib/productCheckoutStop",()=>({...jest.requireActual("@/lib/productCheckoutStop"),stopOriginalProductCheckout:(...args:unknown[])=>mockStop(...args)}));
import {PRODUCT_CHECKOUT_STOP_FLAGS} from "@/lib/productCheckoutStop";
import {POST} from "@/app/api/checkout/stop/route";
const originalEnv={...process.env};
const request=(body:unknown={attemptId:id(1)},origin="https://fixture.invalid")=>new NextRequest("https://fixture.invalid/api/checkout/stop",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{
 jest.clearAllMocks();mockDb.ops.length=0;mockError=null;mockUser={id:id(2)};mockArchive=null;
 mockActive={id:id(1),buyer_id:id(2),attempt_key:id(6),checkout_kind:"full",original_request_protocol:"product-checkout-original-v1"};
 for(const key of PRODUCT_CHECKOUT_STOP_FLAGS)process.env[key]="true";
 mockStop.mockResolvedValue({attemptId:id(1),productId:id(4),status:"released",releasedAt:new Date().toISOString(),releaseAllowed:true});
});
afterAll(()=>{process.env=originalEnv;});
test("authenticated original attempt selects only the server-owned key and common stop runtime",async()=>{
 const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"released",accessGranted:false});
 expect(mockStop).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(6)});
 expect(mockDb.ops[0].filters).toEqual({id:id(1),buyer_id:id(2)});
});
test("lost release reply resolves the exact archived attempt rather than another product checkout",async()=>{
 mockActive=null;mockArchive={attempt_id:id(1),buyer_id:id(2),attempt_key:id(6)};
 expect((await POST(request())).status).toBe(200);expect(mockStop).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(6)});
 expect(mockDb.ops[1].filters).toEqual({attempt_id:id(1),buyer_id:id(2)});
});
test.each(["unauthenticated","origin","extra buyer","invalid id","disabled","wrong owner","legacy","installments","missing","database error"])("%s cannot stop a provider operation",async issue=>{
 let body:unknown={attemptId:id(1)},origin="https://fixture.invalid";
 if(issue==="unauthenticated")mockUser=null;if(issue==="origin")origin="https://other.invalid";
 if(issue==="extra buyer")body={attemptId:id(1),buyerId:id(9)};if(issue==="invalid id")body={attemptId:"no"};
 if(issue==="disabled")process.env.CREATOR_PRODUCT_CHECKOUT_STOP_UI_READY="false";
 if(issue==="wrong owner")mockActive.buyer_id=id(9);if(issue==="legacy")mockActive.original_request_protocol=null;
 if(issue==="installments")mockActive.checkout_kind="installments";if(issue==="missing")mockActive=null;
 if(issue==="database error")mockError={message:"ambiguous"};
 expect((await POST(request(body,origin))).status).toBeGreaterThanOrEqual(400);expect(mockStop).not.toHaveBeenCalled();
});
test("unconfirmed stop remains reconciliation-required without fallback",async()=>{
 mockStop.mockRejectedValue(Error("lost response"));expect((await POST(request())).status).toBe(409);
 expect(mockStop).toHaveBeenCalledTimes(1);expect(mockDb.ops.every(op=>op.kind==="select")).toBe(true);
});
