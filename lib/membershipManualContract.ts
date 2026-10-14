import 'server-only';
import {isDeepStrictEqual} from 'node:util';
import type Stripe from 'stripe';
import {assertMembershipId} from './membershipAgreement';
import {readMembershipRecord,assertMembershipCustomer,assertMembershipHeld,membershipMetadata,membershipCheck as check,membershipStripeId as sid} from './membershipCheckout';
import {readMembershipPayoff,membershipPayoffMetadata} from './membershipPayoff';
import {creatorFeeMetadata} from './money';
import {validateExactPaymentContext,type ExactPaymentContext} from './installments/paymentContext';
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,type ServerPaymentContract} from './serverPaymentConfirmation';

type Selection={id:string;agreement_id:string;buyer_id:string;kind:'first'|'payoff';payoff_id:string|null;
  protocol:typeof SERVER_PAYMENT_PROTOCOL;context:unknown;source:unknown;selected_at:string};

/** Pure source compiler; no database/provider operations or dispatch authority.
 * The runtime must load selection/acceptance/original bootstrap bindings from
 * the owned database and independently retrieve the customer/held subscription.
 * New journal adapters must enforce the same source at durable admission. This
 * function does not retrofit an existing hosted request or manufacture a CS. */
export function buildMembershipManualContract(args:{
  selection:unknown;agreement:unknown;payoff?:unknown;contextEvidence:unknown;now:number;
  customer:Stripe.Customer|Stripe.DeletedCustomer;
  firstPreparation?:{customerId:string;productId:string;subscriptionId:string;subscription:Stripe.Subscription};
}):ServerPaymentContract{
  const a=readMembershipRecord(args.agreement),s=args.selection as Selection,now=args.now;
  check(s&&typeof s==='object'&&!Array.isArray(s)&&Object.keys(s).sort().join(',')===
    'agreement_id,buyer_id,context,id,kind,payoff_id,protocol,selected_at,source');
  assertMembershipId(s.id);
  check(s.agreement_id===a.id&&s.buyer_id===a.buyer_id&&['first','payoff'].includes(s.kind)&&s.protocol===SERVER_PAYMENT_PROTOCOL&&
    isDeepStrictEqual(s.context,a.terms.paymentContext)&&Number.isSafeInteger(now)&&now>0&&
    !a.financial_hold_at&&!a.debit_revoked_at&&!a.billing_review_at&&!a.initial_abandon_requested_at&&!a.initial_abandoned_at);
  const rawContext:ExactPaymentContext={version:'exact-payment-context-v1',mode:a.terms.paymentContext.mode,
    platformAccountId:a.terms.paymentContext.stripeAccountId,supabaseProjectRef:a.terms.paymentContext.supabaseProjectRef,
    siteOrigin:a.terms.paymentContext.siteOrigin};
  check(a.terms.paymentContext.apiVersion==='2025-10-29.clover');
  const context=validateExactPaymentContext(rawContext,args.contextEvidence);
  let amount:number,accepted:number,expiry:number,fingerprint:string,terms:unknown,fees=a.terms.firstMonthFees;
  let metadata:Record<string,string>;
  if(s.kind==='first'){
    check(s.payoff_id===null&&args.payoff===undefined&&a.covered_months===0&&a.anchor_at===null&&
      !a.renewal_stopped_at&&a.stripe_checkout_session_id===null&&args.firstPreparation);
    const b=args.firstPreparation;sid(b.customerId,'cus');sid(b.productId,'prod');sid(b.subscriptionId,'sub');
    check(args.customer.id===b.customerId&&b.subscription.id===b.subscriptionId&&
      (a.stripe_customer_id===null||a.stripe_customer_id===b.customerId)&&
      (a.stripe_subscription_id===null||a.stripe_subscription_id===b.subscriptionId));
    assertMembershipCustomer(args.customer,a,true);
    assertMembershipHeld(b.subscription,a,b.customerId,b.productId,true);
    amount=a.monthly_price_cents;accepted=Math.floor(Date.parse(a.accepted_at)/1000);expiry=accepted+23*3600;
    fingerprint=a.fingerprint;terms=a.terms;
    metadata={...membershipMetadata(a,'manual_first'),membership_subscription_id:b.subscriptionId,...creatorFeeMetadata(fees)};
  }else{
    assertMembershipId(s.payoff_id);const p=readMembershipPayoff(args.payoff,a);
    check(p.id===s.payoff_id&&p.status==='accepted'&&p.checkout_request===null&&p.checkout_dispatched_at===null&&
      p.stripe_checkout_session_id===null&&p.ledger_id===null&&p.provider_proof===null&&args.firstPreparation===undefined&&
      a.stripe_customer_id!==null&&args.customer.id===a.stripe_customer_id);
    assertMembershipCustomer(args.customer,a,false);
    amount=p.terms.amountCents;accepted=Math.floor(Date.parse(p.accepted_at)/1000);expiry=Math.min(accepted+23*3600,p.terms.periodEnd);
    fingerprint=p.fingerprint;terms=p.terms;fees=p.terms.fees;metadata=membershipPayoffMetadata(a,p);
  }
  const selectedAt=Math.floor(Date.parse(s.selected_at)/1000);
  check(Number.isSafeInteger(accepted)&&accepted>0&&Number.isSafeInteger(selectedAt)&&selectedAt>=accepted&&selectedAt<=now&&
    selectedAt<expiry&&now<expiry&&isDeepStrictEqual(s.source,{agreementId:a.id,purchaseId:a.purchase_id,buyerId:a.buyer_id,
      creatorId:a.creator_id,productId:a.product_id,postId:a.post_id,agreementFingerprint:a.fingerprint,sourceFingerprint:fingerprint,
      terms,amountCents:amount,acceptedAt:accepted,expiresAt:expiry,revision:a.revision}));
  const contract:ServerPaymentContract=Object.freeze({protocol:SERVER_PAYMENT_PROTOCOL,attemptId:s.id,buyerId:a.buyer_id,
    creatorId:a.creator_id,productId:a.product_id,termsFingerprint:fingerprint,context,customerId:args.customer.id,
    destinationId:a.terms.destinationId,amountCents:amount,
    processingFees:Object.freeze({enabled:fees.processingFeeEnabled,basisPoints:fees.processingFeeBasisPoints,
      fixedCents:fees.processingFeeFixedCents,version:fees.feeScheduleVersion}),
    kind:s.kind==='first'?'monthly_first':'monthly_payoff',sourceMetadata:Object.freeze(metadata),acceptedAt:accepted,expiresAt:expiry});
  serverPaymentCreateRequest(contract,args.contextEvidence);
  return contract;
}
