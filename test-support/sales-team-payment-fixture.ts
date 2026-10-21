import type Stripe from "stripe";
import { buildTeamSaleAgreement } from "@/lib/salesTeams/agreement";
import { teamIntentRequest,teamPaymentMetadata,type TeamPaymentContract } from "@/lib/salesTeams/paymentProtocol";
import { teamFixtureId as id } from "./sales-team-postgres";
export function teamPaymentFixture(kind:"full"|"installments"|"monthly"="full"){
 const acceptedAt=Math.floor(Date.parse("2026-10-21T12:00:00Z")/1000),now=acceptedAt+60;
 const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
 const evidence={approvedContext:context,vercelEnvironment:"preview" as const,stripeSecretKeyMode:"test" as const,stripePublishableKeyMode:"test" as const,
  observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
 const quote=buildTeamSaleAgreement({saleId:id(20),bookingId:id(21),buyerId:id(10),creatorId:id(1),postId:id(22),membershipId:id(23),closerId:id(2),actingUserId:id(2),
  assignmentRevision:1,commissionRevision:1,commissionBps:1000,holdDays:14,renewals:"initial_commitment",creatorRecipientId:"acct_creator",closerRecipientId:"acct_closer",
  option:{id:id(24),approvalId:id(25),creatorId:id(1),productId:id(26),kind,amountCents:10001,paymentCount:kind==="installments"?3:1,revision:1,sourceSnapshot:{}},
  product:{id:id(26),creator_id:id(1),type:"mentorship",title:"Booked mentorship",amount_cents:10001,price_cents:10001,currency:"usd",
   membership_terms:kind==="monthly"?{version:"monthly-mentorship-v1",minimumMonths:1,autoRenew:true}:null},
  processingFees:{enabled:true,basisPoints:290,fixedCents:30,version:"fixture-fees-v1"},payoutCostEstimateCents:0,feeDisclosureVersion:"fixture-fees-v1",commissionDisclosureVersion:"fixture-commissions-v1"});
 const contract:TeamPaymentContract={protocol:"creatornet-team-distribution-v1",saleId:id(20),obligationId:id(27),operationId:id(28),terms:quote.terms,fingerprint:quote.fingerprint,
  context,customerId:"cus_original",periodNumber:1,amountCents:kind==="installments"?3333:10001,acceptedAt,expiresAt:acceptedAt+86400,kind:"payment"};
 const request=teamIntentRequest(contract,evidence),metadata=teamPaymentMetadata(contract);
 const pi={object:"payment_intent",id:"pi_original",livemode:false,customer:contract.customerId,amount:contract.amountCents,currency:"usd",confirmation_method:"manual",capture_method:"automatic_async",
  application_fee_amount:null,transfer_data:null,on_behalf_of:null,shipping:null,transfer_group:request.params.transfer_group,setup_future_usage:request.params.setup_future_usage??null,
  payment_method_types:["card"],automatic_payment_methods:{enabled:false},metadata,created:acceptedAt+10,amount_capturable:0,amount_received:0,status:"requires_payment_method",latest_charge:null,payment_method:null} as unknown as Stripe.PaymentIntent;
 const token={object:"confirmation_token",id:"ctoken_original",livemode:false,payment_intent:null,setup_intent:null,shipping:null,use_stripe_sdk:true,
  setup_future_usage:request.params.setup_future_usage??null,created:acceptedAt+30,expires_at:acceptedAt+3600,return_url:null,payment_method_options:null,mandate_data:null,
  payment_method_preview:{type:"card",customer:null,card:{country:"US",exp_month:12,exp_year:2027},billing_details:{name:"Buyer",address:{country:"US",line1:"1 Main St",city:"Glendale",state:"AZ",postal_code:"85301"}}}} as unknown as Stripe.ConfirmationToken;
 const paid={...pi,status:"succeeded",amount_received:contract.amountCents,latest_charge:"ch_original"} as Stripe.PaymentIntent;
 const charge={id:"ch_original",object:"charge",livemode:false,paid:true,captured:true,status:"succeeded",payment_intent:pi.id,customer:pi.customer,
  amount:contract.amountCents,amount_captured:contract.amountCents,currency:"usd",application_fee:null,application_fee_amount:null,transfer_data:null,transfer:null,on_behalf_of:null,
  metadata,created:acceptedAt+40,amount_refunded:0,balance_transaction:"txn_original",disputed:false} as unknown as Stripe.Charge;
 return {contract,evidence,request,pi,token,paid,charge,now};
}
