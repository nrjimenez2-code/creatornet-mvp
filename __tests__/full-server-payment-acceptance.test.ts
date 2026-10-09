import {createMockClient,type Op} from "./__mocks__/supabaseQueryMock";
import {acceptFullServerPayment} from "../lib/fullServerPaymentAcceptance";
import {productPurchaseTerms} from "../lib/purchaseConsent";
import {SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
import {productCheckoutFingerprint} from "../lib/productCheckoutFingerprint";
import {createHash} from "node:crypto";

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",
  supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const contextEvidence={approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",stripePublishableKeyMode:"test",
  observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
const product={id:id(4),creator_id:id(3),type:"mentorship",title:"Mentorship",amount_cents:10001,currency:"usd",fixed_service_months:10};
const quote=productPurchaseTerms(product,id(2),id(5));
const env={CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY:"true",CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY:"true",
  CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY:"true",CREATOR_PURCHASE_CONSENT_SCHEMA_READY:"true",
  CREATOR_PURCHASE_POLICIES_READY:"true",CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED:"true",
  CREATOR_FIXED_SERVICE_SCHEMA_READY:"true",CREATOR_FIXED_SERVICE_ONE_TIME_READY:"true"};
let pin:any,order:any,contract:any,issue:string;
function respond(op:Op):{data:unknown;error:unknown} {
  if(issue===op.table)return {data:null,error:{message:"private failure"}};
  if(op.table==="posts")return {data:op.columns?.includes("price_cents")?
    {id:id(5),price_cents:issue==="price"?10002:10001}:{id:id(5),product_id:id(4),creator_id:issue==="ownership"?id(9):id(3)},error:null};
  if(op.table==="profiles")return {data:{id:id(3),stripe_account_id:"acct_creator",stripe_onboarding_complete:issue!=="onboarding"},error:null};
  if(op.table==="record_product_purchase_consent_v1")return {data:id(8),error:null};
  if(op.table==="product_purchase_consents_v1")return {data:{id:id(8),terms:quote.terms,
    fingerprint:issue==="consent fingerprint"?"b".repeat(64):quote.fingerprint,accepted_at:"2026-09-23T00:00:00Z"},error:null};
  if(op.table==="reserve_full_server_payment_v1"){
    const a=(op.payload as any).p_attempt;
    if(pin&&JSON.stringify(pin.source)!==JSON.stringify(a))return {data:null,error:{message:"changed"}};
    pin??={attempt_id:id(1),buyer_id:id(2),product_id:id(4),kind:"full",protocol:SERVER_PAYMENT_PROTOCOL,context,
      source:a,created_at:"2026-09-23T00:00:01Z"};
    return {data:issue==="foreign pin"?{...pin,buyer_id:id(9)}:pin,error:null};
  }
  if(op.table==="orders"){
    if(op.kind==="insert"){
      if(order)return {data:null,error:{code:"23505"}};
      order={...(op.payload as any),stripe_checkout_session_id:null,stripe_payment_intent_id:null};
      if(issue==="lost order reply")return {data:null,error:{message:"timeout"}};
      return {data:null,error:null};
    }
    return {data:issue==="bound order"?{...order,stripe_payment_intent_id:"pi_prior"}:
      issue==="order mismatch"?{...order,creator_amount:0}:order,error:null};
  }
  if(op.table==="save_full_server_payment_contract_v1"){
    contract=(op.payload as any).p_contract;
    return {data:issue==="foreign contract"?{...contract,buyerId:id(9)}:contract,error:null};
  }
  throw Error(`Unexpected ${op.table}`);
}
const db=createMockClient(respond);
const args=()=>({admin:db as any,buyerId:id(2),product:{...product},postId:id(5),attemptId:id(1),attemptKey:id(6),orderId:id(7),
  processingFees:{enabled:true,basisPoints:290,fixedCents:30,version:"fees-v1"},context,contextEvidence,origin:context.siteOrigin,
  acceptance:{accepted:true,version:quote.terms.version,fingerprint:quote.fingerprint},env:{...env}});
beforeEach(()=>{pin=null;order=null;contract=null;issue="";db.ops.length=0;});

test("accepted full choice saves the existing consent, protocol, order and frozen contract without provider dispatch",async()=>{
  expect(await acceptFullServerPayment(args())).toMatchObject({status:"accepted",attemptId:id(1),providerOperationsAllowed:false});
  expect(contract).toMatchObject({kind:"full",amountCents:10001,processingFees:args().processingFees,
    sourceMetadata:{purchase_consent_id:id(8),order_id:id(7),fixed_service_version:"fixed-service-months-v1"}});
  expect(db.ops.map(o=>o.table)).toEqual(["posts","posts","profiles","record_product_purchase_consent_v1",
    "product_purchase_consents_v1","reserve_full_server_payment_v1","orders","orders","save_full_server_payment_contract_v1"]);
  expect(db.opsFor("orders")[1].filters).toEqual({id:id(7),buyer_id:id(2)});
  const saved=structuredClone({pin,order,contract});
  expect(await acceptFullServerPayment(args())).toMatchObject({status:"accepted"});
  expect({pin,order,contract}).toEqual(saved);
});
test.each(Object.keys(env))("disabled %s fails closed",async key=>{
  const a=args();(a.env as any)[key]="false";
  if(key.includes("ACCEPTANCE")||key.includes("PROTOCOL")||key.includes("SOURCE")){
    expect(await acceptFullServerPayment(a)).toEqual({status:"not_enabled"});expect(db.ops).toHaveLength(0);
  }else await expect(acceptFullServerPayment(a)).rejects.toThrow("requires review");
  expect(pin).toBeNull();expect(order).toBeNull();
});
test.each(["price","ownership","onboarding","consent fingerprint","foreign pin","bound order","order mismatch","foreign contract",
  "posts","profiles","record_product_purchase_consent_v1","product_purchase_consents_v1","reserve_full_server_payment_v1","orders",
  "save_full_server_payment_contract_v1"])("%s retains uncertainty without rotation or compensation",async value=>{
  issue=value;await expect(acceptFullServerPayment(args())).rejects.toThrow("Full payment acceptance requires review");
  expect(db.ops.some(o=>o.kind==="update"||o.kind==="delete")).toBe(false);
});
test.each(["origin","context","buyer","product type","consent","missing consent","identity"])("invalid %s cannot reserve",async value=>{
  const a=args();
  if(value==="origin")a.origin="https://other.example";
  if(value==="context")a.context={...context,mode:"live"};
  if(value==="buyer")a.buyerId=id(3);
  if(value==="product type")a.product.type="video";
  if(value==="consent")a.acceptance.fingerprint="b".repeat(64);
  if(value==="missing consent")a.acceptance=null as any;
  if(value==="identity")a.attemptId="invalid";
  await expect(acceptFullServerPayment(a)).rejects.toThrow("requires review");expect(pin).toBeNull();expect(order).toBeNull();
});
test("lost committed order acknowledgement recovers only the same selection and order",async()=>{
  issue="lost order reply";await expect(acceptFullServerPayment(args())).rejects.toThrow("requires review");
  const original=structuredClone({pin,order});issue="";
  expect(await acceptFullServerPayment(args())).toMatchObject({status:"accepted"});
  expect({pin,order}).toEqual(original);
});
test("changed fee snapshot after a lost response cannot rewrite the selection",async()=>{
  issue="lost order reply";await expect(acceptFullServerPayment(args())).rejects.toThrow();issue="";
  const a=args();a.processingFees.fixedCents++;
  await expect(acceptFullServerPayment(a)).rejects.toThrow("requires review");expect(contract).toBeNull();
});
test("extracted fingerprint preserves hosted checkout canonical bytes",()=>{
  const values={z:null,a:50,title:"a=b\nc"};
  expect(productCheckoutFingerprint(values)).toBe(createHash("sha256").update("a=50\ntitle=a=b\nc\nz=").digest("hex"));
});
