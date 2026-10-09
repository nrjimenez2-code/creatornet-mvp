import type Stripe from "stripe";
const mockObserve=jest.fn(),mockFresh=jest.fn(),mockCreate=jest.fn(),mockRetrieve=jest.fn(),mockAccount=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn(),mockExpire=jest.fn(),mockPi=jest.fn();
jest.mock("stripe",()=>({__esModule:true,default:function(){return {checkout:{sessions:{create:mockCreate,retrieve:mockRetrieve,expire:mockExpire}},paymentIntents:{retrieve:mockPi},accounts:{retrieve:mockAccount}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({from:mockFrom,rpc:mockRpc})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),assertFreshExactRuntimeContextObservation:mockFresh}));
import {recoverProductCheckoutOriginalRequest} from "@/lib/productCheckoutOriginalRequest";
import {stopOriginalProductCheckout} from "@/lib/productCheckoutStop";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.invalid"};
const config={approvedContext:context,configuredSupabaseUrl:"https://abcdefghijklmnopqrst.supabase.co",supabaseServiceKey:"fixture",stripeSecretKey:"sk_test_fixture"};
const env={CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY:"true"};
let row:any,params:Stripe.Checkout.SessionCreateParams,session:any,binding:any;
const args=()=>({buyerId:id(2),attemptId:id(1),attemptKey:id(6),candidate:params,env});
beforeEach(()=>{
 jest.resetAllMocks();binding=null;
 const metadata={buyer_id:id(2),creator_id:id(3),product_id:id(4),order_id:id(5),checkout_attempt_key:id(6),checkout_terms_fingerprint:"original"};
 params={mode:"payment",payment_method_types:["card"],line_items:[{quantity:1,price_data:{unit_amount:10000,currency:"usd",product_data:{name:"Original title"}}}],metadata,
 payment_intent_data:{metadata,application_fee_amount:1200,transfer_data:{destination:"acct_creator"}}};
 row={id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),order_id:id(5),attempt_key:id(6),terms_fingerprint:"original",checkout_kind:"full",status:"creating",
 stripe_checkout_session_id:null,original_request_protocol:"product-checkout-original-v1",original_request:null,original_request_context:null};
 session={id:"cs_test_original",mode:"payment",livemode:false,status:"open",payment_status:"unpaid",amount_total:10000,amount_subtotal:10000,currency:"usd",metadata,
 payment_method_types:["card"],total_details:{amount_discount:0,amount_tax:0,amount_shipping:0},url:"https://checkout.stripe.com/fixture"};
 mockObserve.mockResolvedValue({context});mockAccount.mockResolvedValue({id:"acct_creator",charges_enabled:true,payouts_enabled:true,capabilities:{transfers:"active"}});
 mockCreate.mockResolvedValue({id:session.id});mockRetrieve.mockImplementation(async()=>({...session}));
 mockRpc.mockImplementation(async(_name,input)=>{
  row={...row,original_request:row.original_request??input.p_request,original_request_context:context,
   original_request_lease_token:id(7),original_request_started_at:new Date().toISOString()};
  return {error:null,data:{status:row.stripe_checkout_session_id?"bound":"dispatch",attempt:{...row},idempotency_key:`creatornet-product-checkout:${id(6)}`,dispatch_before:new Date(Date.now()+30000).toISOString()}};
 });
 mockFrom.mockImplementation(()=>{
  let update:any=null;
  const q:any={select:()=>q,eq:()=>q,is:()=>q,update:(v:any)=>{update=v;return q;},maybeSingle:async()=>{
   if(update){binding=update;return {error:null,data:{id:row.id,stripe_checkout_session_id:update.stripe_checkout_session_id}};}
   return {error:null,data:{...row}};
  }};return q;
 });
});
test("persists original operation before one create, independently reads and binds original result",async()=>{
 expect((await recoverProductCheckoutOriginalRequest(args())).id).toBe(session.id);
 expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0]);
 expect(mockCreate).toHaveBeenCalledWith(params,{idempotencyKey:`creatornet-product-checkout:${id(6)}`,maxNetworkRetries:0});
 expect(mockRetrieve).toHaveBeenCalledWith(session.id);expect(binding.stripe_checkout_session_id).toBe(session.id);
});
test("recovery uses saved parameters even when current candidate title changes",async()=>{
 const original=JSON.parse(JSON.stringify(params));row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params:original};row.original_request_context=context;
 params.line_items![0].price_data!.product_data!.name="Changed catalog title";
 await recoverProductCheckoutOriginalRequest(args());expect(mockRpc.mock.calls[0][1].p_request).toBeNull();expect(mockCreate.mock.calls[0][0]).toEqual(original);
});
test("lost create response retains original admission without binding or replacement",async()=>{
 mockCreate.mockRejectedValue(Error("lost response"));await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow("lost response");
 expect(row.original_request.params).toEqual(params);expect(mockCreate).toHaveBeenCalledTimes(1);expect(binding).toBeNull();
});
test("bound original session is read without another create",async()=>{
 row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params};row.original_request_context=context;row.stripe_checkout_session_id=session.id;
 await recoverProductCheckoutOriginalRequest(args());expect(mockCreate).not.toHaveBeenCalled();expect(binding).toBeNull();
});
test.each(["busy","reconciliation_required"])("%s never dispatches",async status=>{
 mockRpc.mockResolvedValue({error:null,data:{status}});await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(mockCreate).not.toHaveBeenCalled();
});
test.each(["wrong owner","legacy","context","stale observation","destination","stop requested"])("%s blocks provider dispatch",async issue=>{
 if(issue==="stop requested")row.original_stop_requested_at=new Date().toISOString();
 if(issue==="wrong owner")row.buyer_id=id(9);if(issue==="legacy")row.original_request_protocol=null;
 if(issue==="context"){row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params};row.original_request_context={...context,mode:"live"};}
 if(issue==="stale observation")mockFresh.mockImplementation(()=>{throw Error("stale");});
 if(issue==="destination")mockAccount.mockResolvedValue({id:"acct_other"});
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(mockCreate).not.toHaveBeenCalled();
});
test.each(["amount","metadata","mode","id"])("independent session %s mismatch prevents binding",async issue=>{
 if(issue==="amount")session.amount_total=1;if(issue==="metadata")session.metadata={};if(issue==="mode")session.livemode=true;
 if(issue==="id")mockRetrieve.mockResolvedValue({...session,id:"cs_test_other"});
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(binding).toBeNull();
});
test("disabled gate performs no reads or dispatch",async()=>{
 await expect(recoverProductCheckoutOriginalRequest({...args(),env:{...env,CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY:"false"}})).rejects.toThrow();
 expect(mockObserve).not.toHaveBeenCalled();expect(mockCreate).not.toHaveBeenCalled();
});


test("expired dispatch admission never creates",async()=>{
 const original=mockRpc.getMockImplementation()!;
 mockRpc.mockImplementation(async(...a)=>{const result=await original(...a);result.data.dispatch_before=new Date(Date.now()-1).toISOString();return result;});
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(mockCreate).not.toHaveBeenCalled();
});
test("a changed lease between admission and dispatch blocks create",async()=>{
 mockAccount.mockImplementation(async()=>{row.original_request_lease_token=id(9);return {id:"acct_creator",charges_enabled:true,payouts_enabled:true,capabilities:{transfers:"active"}};});
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(mockCreate).not.toHaveBeenCalled();
});
test("failed binding retains original operation without another create or cleanup",async()=>{
 const original=mockFrom.getMockImplementation()!;
 mockFrom.mockImplementation((...a)=>{const q=original(...a);q.update=()=>{q.maybeSingle=async()=>({error:{message:"lost database response"},data:null});return q;};return q;});
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow();expect(mockCreate).toHaveBeenCalledTimes(1);expect(row.original_request).not.toBeNull();
});

const stopEnv={...env,CREATOR_PRODUCT_CHECKOUT_STOP_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_STOP_OPERATIONS_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_STOP_READY:"true"};
const stop=()=>stopOriginalProductCheckout({...args(),env:stopEnv});
function prepareStop(issue=""){
 row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params};row.original_request_context=context;
 row.stripe_checkout_session_id=session.id;row.status="open";session.payment_intent=null;session.customer=null;
 let operation:any;
 mockRpc.mockImplementation(async(name)=>{
  if(name==="request_product_checkout_stop_v1"){
   row.original_stop_requested_at??=new Date().toISOString();return {error:null,data:{attempt_id:row.id,requested_at:row.original_stop_requested_at,release_allowed:false}};
  }
  if(name!=="claim_product_checkout_stop_operation_v1")throw Error("Unexpected RPC");
  operation={attempt_id:row.id,buyer_id:row.buyer_id,attempt_key:row.attempt_key,context,
   request:{apiVersion:"2025-10-29.clover",method:"POST",path:`/v1/checkout/sessions/${session.id}/expire`,params:{}},
   idempotency_key:`creatornet-product-checkout:${row.attempt_key}:expire`,started_at:new Date().toISOString(),lease_token:id(7),lease_until:new Date(Date.now()+75000).toISOString()};
  if(issue==="changed request")operation.request.params={other:true};
  if(issue==="wrong key")operation.idempotency_key="different";
  return {error:null,data:{status:issue==="busy"?"busy":"dispatch",operation,dispatch_before:new Date(Date.now()+(issue==="expired deadline"?-1000:30000)).toISOString()}};
 });
 const original=mockFrom.getMockImplementation()!;
 mockFrom.mockImplementation(table=>{
  if(table!=="product_checkout_stop_operations_v1")return original(table);
  const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:issue==="lease changed"?{...operation,lease_token:id(9)}:operation})};return q;
 });
 mockExpire.mockImplementation(async()=>{
  session.status=issue==="capture race"?"complete":"expired";if(issue==="capture race")session.payment_status="paid";
  if(issue==="lost reply")throw Error("lost expiry reply");return {...session};
 });
}
test.each(["normal","lost reply"])("original stop persists intent and original operation before expiry: %s",async issue=>{
 prepareStop(issue);expect(await stop()).toEqual({attemptId:id(1),sessionId:session.id,status:"terminal_unpaid",releaseAllowed:false});
 expect(mockExpire).toHaveBeenCalledTimes(1);expect(mockExpire).toHaveBeenCalledWith(session.id,{}, {idempotencyKey:`creatornet-product-checkout:${id(6)}:expire`,maxNetworkRetries:0});
 expect(mockRpc.mock.invocationCallOrder[1]).toBeLessThan(mockExpire.mock.invocationCallOrder[0]);expect(mockCreate).not.toHaveBeenCalled();
});
test.each(["busy","changed request","wrong key","expired deadline","lease changed"])("stop %s cannot expire or release",async issue=>{
 prepareStop(issue);await expect(stop()).rejects.toThrow();expect(mockExpire).not.toHaveBeenCalled();expect(mockCreate).not.toHaveBeenCalled();
 expect(row.original_stop_requested_at).toBeTruthy();
});
test("capture winning expiry remains reconciliation-required with no release",async()=>{
 prepareStop("capture race");expect((await stop()).status).toBe("reconciliation_required");
});
test("already expired original needs independent reads but no new expiry dispatch",async()=>{
 prepareStop();session.status="expired";expect((await stop()).status).toBe("terminal_unpaid");
 expect(mockExpire).not.toHaveBeenCalled();expect(mockRpc.mock.calls.map(a=>a[0])).toEqual(["request_product_checkout_stop_v1"]);
});
test("expired session with unresolved intent never permits release",async()=>{
 prepareStop();session.status="expired";session.payment_intent="pi_original";
 mockPi.mockResolvedValue({id:"pi_original",livemode:false,amount:10000,currency:"usd",customer:null,status:"processing",amount_received:0,amount_capturable:0});
 await expect(stop()).rejects.toThrow();expect(mockExpire).not.toHaveBeenCalled();
});
test.each(["saved","lost proof reply","wrong proof"])("terminal proof runtime %s never releases or replaces checkout",async outcome=>{
 prepareStop();const original=mockRpc.getMockImplementation()!;
 mockRpc.mockImplementation(async(name,input)=>{
  if(name!=="record_product_checkout_stop_proof_v1")return original(name,input);
  if(outcome==="lost proof reply")throw Error("lost proof response");
  return {error:null,data:{attempt_id:row.id,proof:{...input.p_proof,...(outcome==="wrong proof"?{sessionId:"cs_other"}:{})}}};
 });
 const run=()=>stopOriginalProductCheckout({...args(),env:{...stopEnv,CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY:"true"}});
 if(outcome==="saved")expect((await run()).releaseAllowed).toBe(false);else await expect(run()).rejects.toThrow();
 const p=mockRpc.mock.calls.find(([name])=>name==="record_product_checkout_stop_proof_v1")![1].p_proof;
 expect(p).toMatchObject({sessionId:"cs_test_original",checkoutStatus:"expired",paymentStatus:"unpaid",paymentIntent:null,amountCents:10000});
 expect(mockCreate).not.toHaveBeenCalled();expect(mockExpire).toHaveBeenCalledTimes(1);
});
const releaseEnv={...stopEnv,CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY:"true",
 CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_RELEASE_READY:"true"};
test.each(["success","lost reply"])("release runtime verifies original terminal state and recovers %s",async outcome=>{
 prepareStop();let history:any=null;const originalFrom=mockFrom.getMockImplementation()!,originalRpc=mockRpc.getMockImplementation()!;
 mockFrom.mockImplementation(table=>{
  if(table!=="product_checkout_releases_v1")return originalFrom(table);
  const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:history})};return q;
 });
 mockRpc.mockImplementation(async(name,input)=>{
  if(name==="record_product_checkout_stop_proof_v1")return {error:null,data:{attempt_id:row.id,proof:input.p_proof}};
  if(name!=="release_product_checkout_stop_v1")return originalRpc(name,input);
  history={attempt_id:row.id,buyer_id:row.buyer_id,product_id:row.product_id,attempt_key:row.attempt_key,context,original_attempt:{...row},released_at:new Date().toISOString()};
  if(outcome==="lost reply")throw Error("lost release response");
  return {error:null,data:{attempt_id:row.id,product_id:row.product_id,released_at:history.released_at}};
 });
 const run=()=>stopOriginalProductCheckout({...args(),env:releaseEnv});
 if(outcome==="lost reply")await expect(run()).rejects.toThrow("lost release response");else expect((await run()).status).toBe("released");
 const reads=mockRetrieve.mock.calls.length,rpcs=mockRpc.mock.calls.length;
 const recovered=await run();expect(recovered).toMatchObject({attemptId:id(1),productId:id(4),status:"released",releaseAllowed:true});
 expect(mockRetrieve).toHaveBeenCalledTimes(reads);expect(mockRpc).toHaveBeenCalledTimes(rpcs);expect(mockExpire).toHaveBeenCalledTimes(1);expect(mockCreate).not.toHaveBeenCalled();
});
test("release cannot run with proof gate disabled",async()=>{
 prepareStop();await expect(stopOriginalProductCheckout({...args(),env:{...releaseEnv,CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY:"false"}})).rejects.toThrow();
 expect(mockExpire).not.toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});


test("owner recovery needs no catalog candidate when the original request exists",async()=>{
 row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params};row.original_request_context=context;
 const {candidate,...saved}=args();await recoverProductCheckoutOriginalRequest(saved);
 expect(mockRpc.mock.calls[0][1].p_request).toBeNull();expect(mockCreate.mock.calls[0][0]).toEqual(candidate);
});
test("candidate-free recovery cannot invent a request for an unprepared attempt",async()=>{
 const {candidate:_,...saved}=args();await expect(recoverProductCheckoutOriginalRequest(saved)).rejects.toThrow();
 expect(mockRpc).not.toHaveBeenCalled();expect(mockCreate).not.toHaveBeenCalled();
});


test("required billing address survives original dispatch and independent retrieval", async () => {
 params.billing_address_collection="required";session.billing_address_collection="required";
 await recoverProductCheckoutOriginalRequest(args());
 expect(mockCreate.mock.calls[0][0].billing_address_collection).toBe("required");
 expect(binding.stripe_checkout_session_id).toBe(session.id);
});
test.each([undefined,"auto"])("missing or weakened required address setting %s prevents original session binding",async setting=>{
 params.billing_address_collection="required";session.billing_address_collection=setting;
 await expect(recoverProductCheckoutOriginalRequest(args())).rejects.toThrow("requires reconciliation");
 expect(binding).toBeNull();
});
test("address requirement cannot rewrite an already saved original operation",async()=>{
 const original=JSON.parse(JSON.stringify(params));
 row.original_request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params:original};row.original_request_context=context;
 params.billing_address_collection="required";
 await recoverProductCheckoutOriginalRequest(args());
 expect(mockCreate.mock.calls[0][0]).toEqual(original);
 expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("billing_address_collection");
});
