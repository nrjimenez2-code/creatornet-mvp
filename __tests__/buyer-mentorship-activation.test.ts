import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {buyerMentorshipActivationParams,inspectBuyerMentorshipActivationSubscription} from "../lib/mentorshipInstallmentActivation";
function setup(){const f=buyerFirstCaptureFixture();return {...f,paidAt:f.data.charge.created,paymentMethodId:f.data.paymentMethod.id,subscription:f.data.subscription};}
test("activation uses calendar months, captured card, fixed end and indefinite hold",()=>{
  const jan31=Date.parse("2027-01-31T10:11:12Z")/1000;
  const p=buyerMentorshipActivationParams(jan31,3,"pm_owned");
  expect(p).toEqual({trial_end:Date.parse("2027-02-28T10:11:12Z")/1000,cancel_at:Date.parse("2027-04-28T10:11:12Z")/1000,
    default_payment_method:"pm_owned",proration_behavior:"none",pause_collection:{behavior:"keep_as_draft"},
    payment_settings:{payment_method_types:["card"],save_default_payment_method:"off"},metadata:{installment_activation_version:"buyer-first-paid-v1"}});
});
test("original held state is distinct from activated state",()=>{
  const a=setup();expect(inspectBuyerMentorshipActivationSubscription(a)).toMatchObject({itemId:"si_owned",activated:false});
  const p=buyerMentorshipActivationParams(a.paidAt,3,a.paymentMethodId);
  Object.assign(a.subscription,p,{billing_cycle_anchor:p.trial_end,metadata:{...a.subscription.metadata,...p.metadata}});
  expect(()=>inspectBuyerMentorshipActivationSubscription(a)).toThrow();
  expect(inspectBuyerMentorshipActivationSubscription({...a,allowActivated:true})).toMatchObject({activated:true});
});
test.each(["removed hold","resuming hold","wrong card","tax","discount","wrong product","wrong amount","wrong customer","wrong item","billing mode"])("rejects %s",issue=>{
  const a=setup(),s=a.subscription;
  if(issue==="removed hold")s.pause_collection=null;
  if(issue==="resuming hold")s.pause_collection!.resumes_at=a.nowSeconds+60;
  if(issue==="wrong card")s.default_payment_method="pm_other";
  if(issue==="tax")s.automatic_tax.enabled=true;
  if(issue==="discount")s.discounts=["di_other"];
  if(issue==="wrong product")s.items.data[0].price.product="prod_other";
  if(issue==="wrong amount")s.items.data[0].price.unit_amount=1;
  if(issue==="wrong customer")s.customer="cus_other";
  if(issue==="wrong item")s.items.data[0].subscription="sub_other";
  if(issue==="billing mode")s.billing_mode.type="flexible";
  expect(()=>inspectBuyerMentorshipActivationSubscription(a)).toThrow();
});
test("elapsed bootstrap can be inspected for capture but cannot authorize activation",()=>{
  const a=setup();a.nowSeconds+=3*86400;
  expect(()=>inspectBuyerMentorshipActivationSubscription(a)).toThrow();
  expect(inspectBuyerMentorshipActivationSubscription({...a,inspection:"capture"})).toMatchObject({activated:false});
});
