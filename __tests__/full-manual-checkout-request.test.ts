import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {productPurchaseTerms} from "../lib/purchaseConsent";
const mockAccept=jest.fn();
jest.mock("../lib/fullServerPaymentAcceptance",()=>({acceptFullServerPayment:(...a:unknown[])=>mockAccept(...a)}));
import {planFullManualCheckoutRequest,readFullManualCheckoutRequest,findFullManualCheckoutRequest,acceptSavedFullManualCheckout,releaseUnreservedFullManualCheckout} from "../lib/fullManualCheckoutRequest";
let row:any,source:any,issue:string;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const evidence={approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",stripePublishableKeyMode:"test",
  observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
const product={id:id(4),creator_id:id(3),type:"mentorship",title:"Mentorship",amount_cents:10001,currency:"usd",active:true};
const quote=productPurchaseTerms(product,id(2),id(5)),fees={enabled:true,basisPoints:290,fixedCents:30,version:"original-fees"};
const db=createMockClient(op=>{
  if(op.table===issue)return {data:null,error:{message:"private"}};
  if(op.table==="plan_full_manual_checkout_v1"){
    row={request_id:id(1),buyer_id:id(2),product_id:id(4),post_id:id(5),context,attempt_id:id(10),attempt_key:id(11),order_id:id(12),
      created_at:"2026-09-23T00:00:00Z",snapshot:(op.payload as any).p_snapshot};
    return {data:row,error:null};
  }
  if(op.table==="full_manual_checkout_requests_v1")return {data:row,error:null};
  if(op.table==="find_full_manual_checkout_v1")return {data:row,error:null};
  if(op.table==="release_unreserved_full_checkout_v1")return {data:row,error:null};
  if(op.table==="full_server_payment_sources_v1")return {data:source,error:null};
  throw Error("Unexpected request database access");
});
test("product discovery validates the original owner, terms and active state",async()=>{
  const a={...scope(),productId:id(4)};
  expect(await findFullManualCheckoutRequest(a)).toBeNull();const original=await planFullManualCheckoutRequest(args());
  expect(await findFullManualCheckoutRequest(a)).toEqual(original);
  expect(db.opsFor("find_full_manual_checkout_v1")[0].payload).toEqual({p_buyer_id:id(2),p_product_id:id(4),p_context:context});
  row.released_at="2026-09-23T00:01:00Z";await expect(findFullManualCheckoutRequest(a)).rejects.toThrow();
  row.released_at=null;row.buyer_id=id(99);await expect(findFullManualCheckoutRequest(a)).rejects.toThrow();
});
test("no-dispatch release is gated and validates the owned durable marker",async()=>{
  await planFullManualCheckoutRequest(args());
  expect(await releaseUnreservedFullManualCheckout({...scope(),env:{}})).toBeNull();
  expect(db.opsFor("release_unreserved_full_checkout_v1")).toHaveLength(0);
  const enabled={...scope(),env:{CREATOR_FULL_UNRESERVED_RELEASE_READY:"true"}};
  await expect(releaseUnreservedFullManualCheckout(enabled)).rejects.toThrow();
  row.released_at="2026-09-23T00:01:00Z";
  expect((await releaseUnreservedFullManualCheckout(enabled))?.releasedAt).toBe(row.released_at);
  await expect(acceptSavedFullManualCheckout({...scope(),origin:context.siteOrigin})).rejects.toThrow();
  expect(mockAccept).not.toHaveBeenCalled();expect(db.opsFor("full_server_payment_sources_v1")).toHaveLength(0);
});
test.each(["invalid","2099-01-01T00:00:00Z","2025-01-01T00:00:00Z"])("invalid release time %s never unlocks switching",async releasedAt=>{
  await planFullManualCheckoutRequest(args());row.released_at=releasedAt;
  await expect(readFullManualCheckoutRequest(scope())).rejects.toThrow();
});
const scope=()=>({admin:db as any,buyerId:id(2),requestId:id(1),context,contextEvidence:evidence});
const args=()=>({...scope(),product:{...product},postId:id(5),processingFees:{...fees},acceptance:{accepted:true,version:quote.terms.version,fingerprint:quote.fingerprint}});
beforeEach(()=>{jest.resetAllMocks();row=null;source=null;issue="";db.ops.length=0;mockAccept.mockResolvedValue({status:"accepted"});});
test("plan freezes original snapshot and owner read scopes every identity",async()=>{
  const planned=await planFullManualCheckoutRequest(args());expect(await readFullManualCheckoutRequest(scope())).toEqual(planned);
  expect(db.opsFor("full_manual_checkout_requests_v1")[0].filters).toEqual({request_id:id(1),buyer_id:id(2),context});
  expect(planned.snapshot.processingFees).toEqual(fees);expect(planned.terms).toEqual(quote.terms);expect(mockAccept).not.toHaveBeenCalled();
});
test("partial acceptance retries the saved attempt, order, key and fees",async()=>{
  await planFullManualCheckoutRequest(args());mockAccept.mockRejectedValueOnce(Error("lost reply"));
  await expect(acceptSavedFullManualCheckout({...scope(),origin:context.siteOrigin})).rejects.toThrow();
  const result=await acceptSavedFullManualCheckout({...scope(),origin:context.siteOrigin});
  expect(result.attemptId).toBe(id(10));expect(mockAccept.mock.calls[1][0]).toEqual(mockAccept.mock.calls[0][0]);
  expect(mockAccept.mock.calls[1][0]).toMatchObject({attemptId:id(10),attemptKey:id(11),orderId:id(12),processingFees:fees});
});
test("saved contract recovery never regenerates acceptance or current pricing",async()=>{
  await planFullManualCheckoutRequest(args());source={attempt_id:id(10),contract:{attemptId:id(10),buyerId:id(2),creatorId:id(3),productId:id(4),
    kind:"full",amountCents:10001,processingFees:fees,context,sourceMetadata:{checkout_attempt_key:id(11),order_id:id(12)}}};
  expect((await acceptSavedFullManualCheckout({...scope(),origin:context.siteOrigin})).fingerprint).toBe(quote.fingerprint);
  expect(mockAccept).not.toHaveBeenCalled();expect(db.ops.filter(o=>o.kind==="rpc")).toHaveLength(1);
});
test.each(["buyer","context","fingerprint","terms","attempt","source amount","source fees","origin"])("changed %s never silently reaccepts",async value=>{
  await planFullManualCheckoutRequest(args());
  if(value==="buyer")row.buyer_id=id(9);
  if(value==="context")row.context={...context,mode:"live"};
  if(value==="fingerprint")row.snapshot.acceptance.fingerprint="a".repeat(64);
  if(value==="terms")row.snapshot.termsText=row.snapshot.termsText.replace("Mentorship","Other");
  if(value==="attempt")row.attempt_id="invalid";
  if(value.startsWith("source"))source={attempt_id:id(10),contract:{attemptId:id(10),buyerId:id(2),creatorId:id(3),productId:id(4),kind:"full",
    amountCents:value==="source amount"?999:10001,processingFees:value==="source fees"?{...fees,fixedCents:99}:fees,
    context,sourceMetadata:{checkout_attempt_key:id(11),order_id:id(12)}}};
  await expect(acceptSavedFullManualCheckout({...scope(),origin:value==="origin"?"https://other.example":context.siteOrigin})).rejects.toThrow();
  expect(mockAccept).not.toHaveBeenCalled();
});
test.each(["full_manual_checkout_requests_v1","full_server_payment_sources_v1"])("uncertain %s cannot start another acceptance",async name=>{
  await planFullManualCheckoutRequest(args());issue=name;
  await expect(acceptSavedFullManualCheckout({...scope(),origin:context.siteOrigin})).rejects.toThrow();expect(mockAccept).not.toHaveBeenCalled();
});
