import type Stripe from "stripe";
import {hasExpectedFutureEnd} from "../lib/installments/scheduledEnd";

const sub = () => ({status:"active",cancel_at:2000,cancel_at_period_end:false,canceled_at:1100,ended_at:null}) as Stripe.Subscription;
test("observed classic Sandbox bootstrap retains its agreed future end despite canceled_at",()=>{
  // Read from the isolated no-card classic-mode fixture on 2026-09-06.
  // This is a lifecycle-shape regression, not evidence of a paid installment.
  const observed = {
    status: "trialing" as const,
    cancel_at: 1794124198,
    cancel_at_period_end: false,
    canceled_at: 1788680998,
    ended_at: null,
  };
  expect(hasExpectedFutureEnd(observed,1794124198,1788680998,1788680998)).toBe(true);
  expect(hasExpectedFutureEnd({...observed,status:"canceled"},1794124198,1788680998,1788680998)).toBe(false);
  expect(hasExpectedFutureEnd({...observed,ended_at:1788680998},1794124198,1788680998,1788680998)).toBe(false);
});
test.each([null, 1000, 1100, 1200])("scheduled request marker %s is not an immediate cancellation",marker=>{
  const s=sub();s.canceled_at=marker;
  expect(hasExpectedFutureEnd(s,2000,1000,1200)).toBe(true);
});
test.each(["early end","moved end","end of period","ended","canceled","past due","future marker","old marker","invalid marker","expired end"])
("%s does not qualify as the agreed future end",reason=>{
  const s=sub();let now=1200;
  if(reason==="early end")s.cancel_at=1500;
  if(reason==="moved end")s.cancel_at=3000;
  if(reason==="end of period")s.cancel_at_period_end=true;
  if(reason==="ended")s.ended_at=1150;
  if(reason==="canceled")s.status="canceled";
  if(reason==="past due")s.status="past_due";
  if(reason==="future marker")s.canceled_at=1300;
  if(reason==="old marker")s.canceled_at=999;
  if(reason==="invalid marker")s.canceled_at=NaN;
  if(reason==="expired end")now=2000;
  expect(hasExpectedFutureEnd(s,2000,1000,now)).toBe(false);
});
