import {retireProductCheckoutSession} from "@/lib/productCheckoutExpiry";
import type Stripe from "stripe";
function fixture(){
  const session={id:"cs_test_original",mode:"payment",livemode:false,status:"open",payment_status:"unpaid",payment_intent:null,
    customer:"cus_original",amount_total:10001,currency:"usd"} as Stripe.Checkout.Session;
  const retrieve=jest.fn(async()=>({...session})),expire=jest.fn(async()=>{session.status="expired";return session;}),intent=jest.fn();
  const stripe={checkout:{sessions:{retrieve,expire}},paymentIntents:{retrieve:intent}} as unknown as Pick<Stripe,"checkout"|"paymentIntents">;
  return {session,retrieve,expire,intent,args:{session:{...session},stripe,attemptKey:"original-key"}};
}
test("expiry requires independent terminal read and uses original stable operation key",async()=>{
  const f=fixture();expect(await retireProductCheckoutSession(f.args)).toBe("expired");expect(f.retrieve).toHaveBeenCalledTimes(2);
  expect(f.expire).toHaveBeenCalledWith("cs_test_original",{},{idempotencyKey:"creatornet-product-checkout:original-key:expire",maxNetworkRetries:0});
});
test("lost expiry reply recovers the same session",async()=>{
  const f=fixture();f.expire.mockImplementation(async()=>{f.session.status="expired";throw Error("timeout");});
  expect(await retireProductCheckoutSession(f.args)).toBe("expired");expect(f.expire).toHaveBeenCalledTimes(1);
});
test.each(["still open","missing","processing","wrong session"])("%s after expiry never permits replacement",async issue=>{
  const f=fixture();f.expire.mockImplementation(async()=>f.session);
  if(issue==="missing")f.retrieve.mockResolvedValueOnce({...f.session}).mockRejectedValueOnce(Error("missing"));
  if(issue==="processing")f.retrieve.mockResolvedValueOnce({...f.session}).mockResolvedValueOnce({...f.session,status:"expired",payment_status:"unpaid",payment_intent:"pi_original"});
  if(issue==="wrong session")f.retrieve.mockResolvedValueOnce({...f.session}).mockResolvedValueOnce({...f.session,id:"cs_test_other",status:"expired"});
  f.intent.mockResolvedValue({id:"pi_original",status:"processing",customer:"cus_original",livemode:false,amount:10001,currency:"usd",amount_received:0,amount_capturable:0});
  await expect(retireProductCheckoutSession(f.args)).rejects.toThrow();
});
test.each(["canceled","requires_action","succeeded"])("expired session with %s intent is reconciled before replacement",async status=>{
  const f=fixture();f.session.status="expired";f.session.payment_intent="pi_original";
  f.intent.mockResolvedValue({id:"pi_original",status,customer:"cus_original",livemode:false,amount:10001,currency:"usd",amount_received:0,amount_capturable:0});
  if(status==="canceled")expect(await retireProductCheckoutSession(f.args)).toBe("expired");
  else await expect(retireProductCheckoutSession(f.args)).rejects.toThrow();
  expect(f.expire).not.toHaveBeenCalled();
});
test("a completed race returns complete without granting payment or replacement authority",async()=>{
  const f=fixture();f.expire.mockImplementation(async()=>{f.session.status="complete";f.session.payment_status="paid";return f.session;});
  expect(await retireProductCheckoutSession(f.args)).toBe("complete");
});
