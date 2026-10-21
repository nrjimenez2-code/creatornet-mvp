import {fullServerCaptureFixture as fixture} from "../test-support/full-server-capture-fixture";
import {inspectFullServerPaymentCapture} from "../lib/fullServerPaymentReceipt";
import {fixedServiceEndAt} from "../lib/fixedServiceTerms";


test("full capture preserves original economics, null Checkout and independent service duration without provider writes",()=>{
  const f=fixture(),before=JSON.stringify(f),proof=inspectFullServerPaymentCapture(f);
  expect(proof).toMatchObject({version:"full-server-payment-capture-v1",attemptId:f.contract.attemptId,
    checkoutSessionId:null,customerId:null,paymentIntentId:"pi_owned",chargeId:"ch_owned",transferId:"tr_owned",
    actualStripeFeeCents:127,amountCents:3333,fees:{platformFeeCents:400,processingFeeCents:127,creatorNetCents:2806},
    serviceEndsAt:fixedServiceEndAt(f.data.charge.created,36)});
  expect(JSON.stringify(f)).toBe(before);expect(JSON.stringify(proof)).not.toMatch(/client_secret|Fixture Way|4242/);
});
test("capture recovery after selection expiry retains the original capture/service dates",()=>{
  const f=fixture(),first=inspectFullServerPaymentCapture(f);f.nowSeconds+=90*86400;
  expect(inspectFullServerPaymentCapture(f)).toEqual(first);
});
test("missing historical service duration is not replaced with a guessed duration",()=>{
  const f=fixture();delete (f.consent.terms as any).serviceMonths;delete (f.consent.terms as any).serviceVersion;
  delete (f.contract.sourceMetadata as any).fixed_service_version;
  delete f.data.paymentIntent.metadata.fixed_service_version;
  expect(inspectFullServerPaymentCapture(f).serviceEndsAt).toBeNull();
});
const corruptions:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  "installment source":f=>{(f.contract as any).kind="first_installment";},
  "foreign owner":f=>{f.consent.terms.buyerId=f.contract.creatorId;},
  "different consent":f=>{f.consent.id=f.contract.creatorId;},
  "different accepted date":f=>{f.consent.accepted_at=new Date((f.contract.acceptedAt+1)*1000).toISOString();},
  "different post":f=>{f.consent.terms.postId=f.contract.creatorId;},
  "different policy":f=>{f.consent.terms.version="changed";},
  "different money":f=>{f.consent.terms.amountCents++;},
  "different duration protocol":f=>{f.consent.terms.serviceVersion="changed";},
  "invalid duration":f=>{f.consent.terms.serviceMonths=0;},
  "invalid confirmation":f=>{f.confirmationOperationId="not-an-operation";},
  "foreign account":f=>{f.contextEvidence.observedPlatformAccountId="acct_other";},
  "processing intent":f=>{f.data.paymentIntent.status="processing";f.data.paymentIntent.amount_received=0;},
  "wrong intent":f=>{f.data.paymentIntent.id="pi_other";},
  "wrong fee":f=>{f.data.paymentIntent.application_fee_amount!++;},
  "foreign intent metadata":f=>{f.data.paymentIntent.metadata.buyer_id=f.contract.creatorId;},
  "wrong charge":f=>{f.data.charge.id="ch_other";},
  "foreign charge intent":f=>{f.data.charge.payment_intent="pi_other";},
  "unpaid charge":f=>{f.data.charge.paid=false;},
  "uncaptured charge":f=>{f.data.charge.captured=false;},
  "partial capture":f=>{f.data.charge.amount_captured--;},
  "foreign charge mode":f=>{f.data.charge.livemode=true;},
  "foreign charge method":f=>{f.data.charge.payment_method="pm_other";},
  "foreign charge country":f=>{f.data.charge.billing_details.address!.country="CA";},
  "foreign method country":f=>{f.data.paymentMethod.billing_details.address!.country="CA";},
  "foreign customer":f=>{f.data.paymentMethod.customer="cus_other";},
  "future capture":f=>{f.data.charge.created=f.nowSeconds+1;},
  "expired capture":f=>{f.nowSeconds=f.contract.expiresAt+10;f.data.charge.created=f.contract.expiresAt+1;},
  "capture before create":f=>{f.data.charge.created=f.data.paymentIntent.created-1;},
  "foreign balance source":f=>{f.data.balance.source="ch_other";},
  "foreign balance currency":f=>{f.data.balance.currency="cad";},
  "wrong balance amount":f=>{f.data.balance.amount++;},
  "wrong balance net":f=>{f.data.balance.net++;},
  "missing asynchronous balance":f=>{f.data.charge.balance_transaction=null;},
  "missing asynchronous transfer":f=>{f.data.charge.transfer=undefined;},
  "refunded charge":f=>{f.data.charge.amount_refunded=1;},
  "disputed charge":f=>{f.data.charge.disputed=true;},
};
test.each(Object.entries(corruptions))("%s cannot become clean full capture evidence",(_name,mutate)=>{
  const f=fixture();mutate(f);expect(()=>inspectFullServerPaymentCapture(f)).toThrow();
});
test("refund inspection can read captured money without admitting it as clean credit",()=>{
  const f=fixture();f.data.charge.amount_refunded=3333;f.data.charge.refunded=true;
  expect(()=>inspectFullServerPaymentCapture(f)).toThrow();
  expect(inspectFullServerPaymentCapture({...f,financialInspection:"refund"}).chargeId).toBe("ch_owned");
  f.data.charge.amount_refunded=3334;expect(()=>inspectFullServerPaymentCapture({...f,financialInspection:"refund"})).toThrow();
});
test("dispute inspection does not also permit an unreviewed refund",()=>{
  const f=fixture();f.data.charge.disputed=true;
  expect(inspectFullServerPaymentCapture({...f,financialInspection:"dispute"}).chargeId).toBe("ch_owned");
  f.data.charge.amount_refunded=1;expect(()=>inspectFullServerPaymentCapture({...f,financialInspection:"dispute"})).toThrow();
});

test("explicit combined inspection retains both signals without making clean or single-outcome evidence",()=>{
  const f=fixture();f.data.charge.disputed=true;f.data.charge.amount_refunded=1000;
  expect(()=>inspectFullServerPaymentCapture(f)).toThrow();
  expect(()=>inspectFullServerPaymentCapture({...f,financialInspection:"refund"})).toThrow();
  expect(()=>inspectFullServerPaymentCapture({...f,financialInspection:"dispute"})).toThrow();
  expect(inspectFullServerPaymentCapture({...f,financialInspection:"refund_and_dispute"}).paymentIntentId).toBe("pi_owned");
  f.data.charge.amount_refunded=3334;
  expect(()=>inspectFullServerPaymentCapture({...f,financialInspection:"refund_and_dispute"})).toThrow();
});
