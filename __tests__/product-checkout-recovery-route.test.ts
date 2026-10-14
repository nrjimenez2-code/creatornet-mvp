import {NextRequest} from "next/server";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let mockUser:{id:string}|null,mockRow:any,mockDbError:any,mockArchived:any,mockConsent:any;
const mockRecover=jest.fn(),mockObserve=jest.fn(),mockAttach=jest.fn();
const mockDb=createMockClient(op=>({data:op.table==="product_checkout_releases_v1"?mockArchived:op.table==="product_purchase_consents_v1"?mockConsent:mockRow,error:mockDbError}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:async()=>mockUser}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:{siteOrigin:"https://fixture.invalid"},configuredSupabaseUrl:"https://fixture.supabase.co",supabaseServiceKey:"fixture"})}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),assertFreshExactRuntimeContextObservation:()=>{}}));
jest.mock("@/lib/productCheckoutOriginalRequest",()=>({recoverProductCheckoutOriginalRequest:(...a:unknown[])=>mockRecover(...a)}));
jest.mock("@/lib/productCheckoutAttachment",()=>({attachOriginalProductCheckout:(...a:unknown[])=>mockAttach(...a)}));
import {GET,POST} from "@/app/api/checkout/recover/route";
import {PRODUCT_CHECKOUT_STOP_FLAGS} from "@/lib/productCheckoutStop";
const saved={...process.env};
const request=(body:unknown={productId:id(4)},origin="https://fixture.invalid")=>new NextRequest("https://fixture.invalid/api/checkout/recover",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{
 jest.clearAllMocks();mockDb.ops.length=0;mockDbError=null;mockUser={id:id(2)};
 mockArchived=null;mockConsent=null;for(const key of PRODUCT_CHECKOUT_STOP_FLAGS)process.env[key]="false";
 mockAttach.mockResolvedValue(undefined);
 Object.assign(process.env,{CREATOR_PRODUCT_CHECKOUT_RECOVERY_READY:"true",CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY:"true"});
 mockRow={id:id(1),buyer_id:id(2),product_id:id(4),attempt_key:id(6),checkout_kind:"full",original_request_protocol:"product-checkout-original-v1"};
 mockRecover.mockResolvedValue({id:"cs_test_original",status:"open",payment_status:"unpaid",url:"https://checkout.stripe.com/original",metadata:{private:"hidden"}});
});
afterAll(()=>{process.env=saved;});
test("owned recovery uses only original IDs with no catalog or new consent",async()=>{
 const response=await POST(request());expect(response.status).toBe(200);
 expect(await response.json()).toEqual({attemptId:id(1),productId:id(4),sessionId:"cs_test_original",accessGranted:false,canSwitchPaymentMode:false,status:"checkout_open",url:"https://checkout.stripe.com/original"});
 expect(mockRecover).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(6)});
 expect(mockDb.ops.map(op=>op.table)).toEqual(["product_checkout_attempts"]);expect(response.headers.get("Cache-Control")).toContain("no-store");
});
test.each(["unauthenticated","origin","extra identity","malformed product","disabled","missing","wrong owner","legacy","ambiguous rows"])("%s cannot recover or create",async issue=>{
 let body:unknown={productId:id(4)},origin="https://fixture.invalid";
 if(issue==="unauthenticated")mockUser=null;if(issue==="origin")origin="https://other.invalid";
 if(issue==="extra identity")body={productId:id(4),buyerId:id(9)};if(issue==="malformed product")body={productId:"invalid"};
 if(issue==="disabled")process.env.CREATOR_PRODUCT_CHECKOUT_RECOVERY_READY="false";if(issue==="missing")mockRow=null;
 if(issue==="wrong owner")mockRow.buyer_id=id(9);if(issue==="legacy")mockRow.original_request_protocol=null;
 if(issue==="ambiguous rows")mockDbError={message:"multiple rows"};
 expect((await POST(request(body,origin))).status).toBeGreaterThanOrEqual(400);expect(mockRecover).not.toHaveBeenCalled();
});
test.each(["complete","expired"])("%s is not access or release proof",async status=>{
 mockRecover.mockResolvedValue({id:"cs_test_original",status,payment_status:status==="complete"?"paid":"unpaid",url:null});
 const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({attemptId:id(1),productId:id(4),sessionId:"cs_test_original",status:"reconciliation_required",accessGranted:false,canSwitchPaymentMode:false});
});
test("uncertain runtime preserves original without fallback",async()=>{
 mockRecover.mockRejectedValue(Error("lost provider reply"));const response=await POST(request());expect(response.status).toBe(409);
 expect(mockRecover).toHaveBeenCalledTimes(1);expect(mockDb.ops.every(op=>op.kind==="select")).toBe(true);
});
test("untrusted checkout URL is never published",async()=>{
 mockRecover.mockResolvedValue({id:"cs_test_original",status:"open",payment_status:"unpaid",url:"https://other.invalid"});expect((await POST(request())).status).toBe(409);
});
test("lost attachment response withholds the URL and retries only original recovery",async()=>{
 mockAttach.mockRejectedValueOnce(Error("lost attachment reply"));
 expect((await POST(request())).status).toBe(409);
 expect((await POST(request())).status).toBe(200);
 expect(mockRecover.mock.calls).toEqual([[{buyerId:id(2),attemptId:id(1),attemptKey:id(6)}],[{buyerId:id(2),attemptId:id(1),attemptKey:id(6)}]]);
 expect(mockAttach).toHaveBeenCalledTimes(2);
});
test("explicit original recovery cannot adopt a newer attempt for the same product",async()=>{
 expect((await POST(request({productId:id(4),attemptId:id(9)}))).status).toBe(409);
 expect(mockDb.ops[0].filters.id).toBe(id(9));expect(mockRecover).not.toHaveBeenCalled();
});

const readRequest=(query=`product_id=${id(4)}`)=>new NextRequest(`https://fixture.invalid/api/checkout/recover?${query}`);
test("read-only owned capability exposes no original parameters and never calls Stripe",async()=>{
 process.env.CREATOR_PRODUCT_CHECKOUT_RECOVERY_UI_READY="true";mockRow.original_request={private:"original parameters"};
 const response=await GET(readRequest());expect(response.status).toBe(200);
 expect(await response.json()).toEqual({attemptId:id(1),productId:id(4),status:"saved_checkout",canRecover:true,canStopUnpaid:false,accessGranted:false,canSwitchPaymentMode:false});
 expect(mockRecover).not.toHaveBeenCalled();expect(mockObserve).not.toHaveBeenCalled();
 expect(mockDb.ops.every(op=>op.kind==="select"&&op.table==="product_checkout_attempts")).toBe(true);
 expect(mockDb.ops[0].filters).toMatchObject({buyer_id:id(2),product_id:id(4),checkout_kind:"full"});
});
test.each(["ui disabled","runtime disabled","legacy","no original","stop requested"])("read-only recovery keeps the lock with %s",async issue=>{
 process.env.CREATOR_PRODUCT_CHECKOUT_RECOVERY_UI_READY="true";mockRow.original_request={private:"original"};
 if(issue==="ui disabled")process.env.CREATOR_PRODUCT_CHECKOUT_RECOVERY_UI_READY="false";
 if(issue==="runtime disabled")process.env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY="false";
 if(issue==="legacy")mockRow.original_request_protocol=null;if(issue==="no original")mockRow.original_request=null;
 if(issue==="stop requested")mockRow.original_stop_requested_at=new Date().toISOString();
 const response=await GET(readRequest());expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({canRecover:false,canSwitchPaymentMode:false,accessGranted:false});expect(mockRecover).not.toHaveBeenCalled();
});
test.each(["unauthenticated","schema disabled","wrong owner","missing","ambiguous","extra query","duplicate query"])("read-only capability rejects %s",async issue=>{
 let query=`product_id=${id(4)}`;
 if(issue==="unauthenticated")mockUser=null;if(issue==="schema disabled")process.env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY="false";
 if(issue==="wrong owner")mockRow.buyer_id=id(9);if(issue==="missing")mockRow=null;if(issue==="ambiguous")mockDbError={message:"multiple"};
 if(issue==="extra query")query+="&buyer_id="+id(2);if(issue==="duplicate query")query+="&product_id="+id(4);
 expect((await GET(readRequest(query))).status).toBeGreaterThanOrEqual(400);expect(mockRecover).not.toHaveBeenCalled();
});
test("stop capability requires every gate and original consent without publishing provider data",async()=>{
 for(const key of PRODUCT_CHECKOUT_STOP_FLAGS)process.env[key]="true";
 mockRow.original_request={private:"hidden"};mockRow.stripe_checkout_session_id="cs_original";mockRow.purchase_consent_id=id(8);
 mockConsent={buyer_id:id(2),product_id:id(4),fingerprint:"f".repeat(64)};
 const response=await GET(readRequest());expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({attemptId:id(1),canStopUnpaid:true,buyerId:id(2),fingerprint:"f".repeat(64),canSwitchPaymentMode:false});
 expect(mockRecover).not.toHaveBeenCalled();
});
test.each(["valid","wrong owner","wrong context","wrong consent"])("original release readback %s",async issue=>{
 process.env.CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY="true";mockRow=null;
 mockArchived={attempt_id:id(1),buyer_id:issue==="wrong owner"?id(9):id(2),product_id:id(4),context:{siteOrigin:issue==="wrong context"?"https://other.invalid":"https://fixture.invalid"},
  original_attempt:{id:id(1),buyer_id:id(2),product_id:id(4),purchase_consent_id:id(8)},released_at:new Date().toISOString()};
 mockConsent={buyer_id:id(2),product_id:issue==="wrong consent"?id(9):id(4),fingerprint:"f".repeat(64)};
 const response=await GET(readRequest(`product_id=${id(4)}&attempt_id=${id(1)}`));
 if(issue==="valid")expect(await response.json()).toMatchObject({attemptId:id(1),productId:id(4),status:"released",canSwitchPaymentMode:true,canStopUnpaid:false,accessGranted:false});
 else expect(response.status).toBe(409);expect(mockRecover).not.toHaveBeenCalled();
});
