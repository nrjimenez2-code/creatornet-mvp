import type Stripe from "stripe";
import {teamPaymentFixture} from "./sales-team-payment-fixture";
import {teamPaymentMetadata,type TeamPaymentContract} from "@/lib/salesTeams/paymentProtocol";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
import type {TeamCaptureConfirmation} from "@/lib/salesTeams/receiptPolicy";
import type {ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
export function teamCaptureFixture(contract:TeamPaymentContract=teamPaymentFixture("installments").contract,confirmation?:TeamCaptureConfirmation){
 const f=teamPaymentFixture("installments"),paidAt=contract.acceptedAt+40;
 const binding:TeamCaptureConfirmation=confirmation??{operationId:"00000000-0000-4000-8000-000000000070",paymentIntentId:"pi_original",firstDispatchAt:contract.acceptedAt+35,lastDispatchAt:contract.acceptedAt+35,
  request:{method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:"/v1/payment_intents/pi_original/confirm",params:{confirmation_token:"ctoken_original",use_stripe_sdk:true,return_url:`${contract.context.siteOrigin}/purchase/team/${contract.saleId}`}},
  tokenProof:{tokenId:"ctoken_original",createdAt:contract.acceptedAt+30,expiresAt:contract.acceptedAt+3600,previewHash:"a".repeat(64),country:"US"}};
 const pi={...f.paid,customer:contract.customerId,amount:contract.amountCents,amount_received:contract.amountCents,metadata:teamPaymentMetadata(contract),
  setup_future_usage:contract.terms.paymentKind==="full"?null:"off_session",transfer_group:`cn_team_${contract.saleId}`,created:contract.acceptedAt+10,payment_method:"pm_original"} as Stripe.PaymentIntent;
 const charge={...f.charge,customer:contract.customerId,metadata:pi.metadata,amount:pi.amount,amount_captured:pi.amount,created:paidAt,payment_method:"pm_original",refunded:false,
  billing_details:f.token.payment_method_preview!.billing_details,payment_method_details:{type:"card",card:{country:"US"}},lastResponse:{requestId:"req_chargeRead"}} as unknown as Stripe.Response<Stripe.Charge>;
 const balance={id:"txn_original",object:"balance_transaction",source:charge.id,type:"charge",currency:"usd",amount:pi.amount,fee:127,net:pi.amount-127,
  created:paidAt+2,available_on:paidAt+86400,status:"pending",fee_details:[{amount:127,currency:"usd",application:null,type:"stripe_fee",description:"Actual fixture cost"}],lastResponse:{requestId:"req_balanceRead"}} as unknown as Stripe.Response<Stripe.BalanceTransaction>;
 const evidence:ExactPaymentContextEvidence=f.evidence;
 return {contract,evidence,confirmation:binding,paymentIntent:pi,charge,balance,nowSeconds:contract.acceptedAt+60};
}
