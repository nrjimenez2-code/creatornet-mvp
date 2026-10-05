/** @jest-environment node */
import type Stripe from 'stripe';
import {buildMembershipManualContract} from '@/lib/membershipManualContract';
import {serverPaymentCreateRequest,inspectServerPaymentIntent,inspectServerConfirmationToken,serverPaymentConfirmationRequest,SERVER_PAYMENT_PROTOCOL} from '@/lib/serverPaymentConfirmation';
import {membershipFixture} from '../test-support/membership-fixtures';
import {membershipPayoffFixture} from '../test-support/membership-payoff-fixtures';
import {serverPaymentFixture} from '../test-support/server-payment-fixture';

const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
function fixture(kind:'first'|'payoff'){
  const first=membershipFixture(),payoff=membershipPayoffFixture(false),f=kind==='first'?first:payoff,a=f.a,now=Math.floor(Date.now()/1000);
  a.stripe_checkout_session_id=kind==='first'?null:a.stripe_checkout_session_id;
  const p=payoff.p;p.status='accepted';p.checkout_request=null;p.checkout_dispatched_at=null;p.stripe_checkout_session_id=null;
  const accepted=Math.floor(Date.parse(kind==='first'?a.accepted_at:p.accepted_at)/1000),expiry=kind==='first'?accepted+23*3600:Math.min(accepted+23*3600,p.terms.periodEnd);
  const context={version:'exact-payment-context-v1',mode:a.terms.paymentContext.mode,platformAccountId:a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef:a.terms.paymentContext.supabaseProjectRef,siteOrigin:a.terms.paymentContext.siteOrigin};
  const evidence={approvedContext:context,vercelEnvironment:'preview',stripeSecretKeyMode:'test',stripePublishableKeyMode:'test',
    observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
    configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
  const selection={id:'40000000-0000-4000-8000-000000000001',agreement_id:a.id,buyer_id:a.buyer_id,kind,
    payoff_id:kind==='first'?null:p.id,protocol:SERVER_PAYMENT_PROTOCOL,context:a.terms.paymentContext,selected_at:new Date((now-1)*1000).toISOString(),
    source:{agreementId:a.id,purchaseId:a.purchase_id,buyerId:a.buyer_id,creatorId:a.creator_id,productId:a.product_id,postId:a.post_id,
      agreementFingerprint:a.fingerprint,sourceFingerprint:kind==='first'?a.fingerprint:p.fingerprint,terms:kind==='first'?a.terms:p.terms,
      amountCents:kind==='first'?a.monthly_price_cents:p.terms.amountCents,acceptedAt:accepted,expiresAt:expiry,revision:a.revision}};
  const args:Parameters<typeof buildMembershipManualContract>[0]={selection,agreement:a,contextEvidence:evidence,now,customer:f.customer,
    ...(kind==='first'?{firstPreparation:{customerId:f.customer.id,productId:f.product.id,subscriptionId:f.subscription.id,subscription:f.subscription}}:{payoff:p})};
  return {f,a,p,selection,evidence,args,now};
}
test.each(['first','payoff'] as const)('derives %s contract from the original acceptance and reuses manual intent construction',kind=>{
  const h=fixture(kind),c=buildMembershipManualContract(h.args),request=serverPaymentCreateRequest(c,h.evidence);
  expect(c.attemptId).toBe(h.selection.id);expect(c.amountCents).toBe(h.selection.source.amountCents);
  expect(c.termsFingerprint).toBe(h.selection.source.sourceFingerprint);expect(c.expiresAt).toBe(h.selection.source.expiresAt);
  expect(request.params).toMatchObject({confirm:false,confirmation_method:'manual',capture_method:'automatic_async',customer:h.f.customer.id,
    amount:c.amountCents,application_fee_amount:kind==='first'?h.a.terms.firstMonthFees.totalCreatorDeductionCents:h.p.terms.fees.totalCreatorDeductionCents,
    transfer_data:{destination:h.a.terms.destinationId}});
  expect(request.params.setup_future_usage).toBe(kind==='first'?'off_session':undefined);
  expect(c.sourceMetadata).not.toHaveProperty('checkout_session_id');expect(Object.isFrozen(c)).toBe(true);
});
test.each(['first','payoff'] as const)('%s shares manual-only intent inspection and US token confirmation',kind=>{
  const h=fixture(kind),c=buildMembershipManualContract(h.args),request=serverPaymentCreateRequest(c,h.evidence);
  const pi={...request.params,id:'pi_monthly',object:'payment_intent',livemode:false,created:h.now-2,status:'requires_payment_method',
    customer:c.customerId,payment_method:null,latest_charge:null,amount_received:0,amount_capturable:0,setup_future_usage:request.params.setup_future_usage??null,
    automatic_payment_methods:{enabled:false},on_behalf_of:null,shipping:null,transfer_group:null} as unknown as Stripe.PaymentIntent;
  const binding={paymentIntentId:pi.id,firstDispatchAt:h.now-2};
  expect(inspectServerPaymentIntent(c,h.evidence,pi,binding,h.now)).toBe(pi);
  expect(()=>inspectServerPaymentIntent(c,h.evidence,{...pi,confirmation_method:'automatic'},binding,h.now)).toThrow();
  const token=copy(serverPaymentFixture().token);token.created=h.now-1;token.expires_at=h.now+600;
  token.setup_future_usage=kind==='first'?'off_session':null;
  const proof=inspectServerConfirmationToken(c,h.evidence,token,token.id,h.now);
  const confirm=serverPaymentConfirmationRequest(c,pi.id,{kind:'token',token:proof});
  expect(confirm.params.return_url).toBe(`${c.context.siteOrigin}/memberships/payment/return?attempt=${c.attemptId}`);
  token.payment_method_preview!.billing_details.address!.country='CA';
  expect(()=>inspectServerConfirmationToken(c,h.evidence,token,token.id,h.now)).toThrow();
});
test.each(['amount','fingerprint','terms','revision','expiry','owner','context','customer','stop','extra'] as const)('rejects changed source %s',fault=>{
  const h=fixture('first');
  if(fault==='amount')h.selection.source.amountCents++;
  if(fault==='fingerprint')h.selection.source.sourceFingerprint='a'.repeat(64);
  if(fault==='terms')h.selection.source.terms={...h.selection.source.terms,monthlyPriceCents:999} as typeof h.selection.source.terms;
  if(fault==='revision')h.a.revision++;
  if(fault==='expiry')h.selection.source.expiresAt++;
  if(fault==='owner')h.selection.buyer_id=h.a.creator_id;
  if(fault==='context')h.evidence.observedPlatformAccountId='acct_other';
  if(fault==='customer')h.args.customer={...h.f.customer,id:'cus_other'};
  if(fault==='stop')h.a.debit_revoked_at=new Date().toISOString();
  if(fault==='extra')Object.assign(h.selection,{replacementAmount:100});
  expect(()=>buildMembershipManualContract(h.args)).toThrow();
});
test.each(['checkout','subscription','unheld','expired'] as const)('first payment refuses %s preparation',fault=>{
  const h=fixture('first');
  if(fault==='checkout')h.a.stripe_checkout_session_id='cs_original';
  if(fault==='subscription')h.args.firstPreparation!.subscriptionId='sub_other';
  if(fault==='unheld')h.args.firstPreparation!.subscription.pause_collection=null;
  if(fault==='expired')h.args.now=h.selection.source.expiresAt;
  expect(()=>buildMembershipManualContract(h.args)).toThrow();
});
test.each(['request','session','status','payoffId','expired'] as const)('payoff refuses %s drift',fault=>{
  const h=fixture('payoff');
  if(fault==='request')h.p.checkout_request={alreadyAdmitted:true};
  if(fault==='session')h.p.stripe_checkout_session_id='cs_original';
  if(fault==='status')h.p.status='review_required';
  if(fault==='payoffId')h.selection.payoff_id='40000000-0000-4000-8000-000000000002';
  if(fault==='expired')h.args.now=h.selection.source.expiresAt;
  expect(()=>buildMembershipManualContract(h.args)).toThrow();
});
