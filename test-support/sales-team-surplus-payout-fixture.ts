import type Stripe from "stripe";
import {teamOperationId} from "@/lib/salesTeams/providerOperation";
import type {TeamSurplusMoneySource} from "@/lib/salesTeams/surplusPayoutPolicy";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
export function teamSurplusPayoutFixture(now=Math.floor(Date.now()/1000)){
 const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
 const scope={scopeId:id(1),scopeKey:"surplus:v1",kind:"withdrawal" as const,saleId:null,creatorId:null,actorId:null,workerRunId:id(2)},operationId=teamOperationId(scope);
 const request={method:"POST" as const,apiVersion:"2026-08-26.dahlia",path:"/v1/payouts",params:{amount:5000,currency:"usd",destination:"ba_approved",method:"standard",source_type:"card",metadata:{team_protocol:"creatornet-team-surplus-v1",team_surplus_request_id:id(1),team_provider_operation_id:operationId}}};
 const q:TeamSurplusMoneySource={id:id(1),operation_id:operationId,original_worker_run_id:id(2),read_id:id(3),amount_cents:5000,cost_reserve_cents:20,destination_id:"ba_approved",context,
  policy:{context,destination_id:"ba_approved",minimum_cents:50,maximum_cents:5000,cost_reserve_cents:20,prerequisites_verified:true,contract_sha256:"a".repeat(64),revision:1},
  protection:{scope:"synthetic payout fixture only"},scope,request,resolved:false,created_at:new Date((now-20)*1000).toISOString(),
  operation:{...scope,id:operationId,context,request,status:"bound",idempotency_key:`cn-team-v1:${operationId}`,first_dispatch_at:new Date((now-10)*1000).toISOString(),provider_id:"po_original",provider_request_id:"req_payoutCreated"}};
 const payout={id:"po_original",object:"payout",amount:5000,arrival_date:now+86400,automatic:false,balance_transaction:"txn_debit",created:now-5,currency:"usd",destination:"ba_approved",
  failure_balance_transaction:null,failure_code:null,failure_message:null,livemode:false,metadata:request.params.metadata,method:"standard",original_payout:null,reconciliation_status:"not_applicable",reversed_by:null,source_type:"card",status:"pending",type:"bank_account",application_fee:null,application_fee_amount:null,
  trace_id:{status:"supported",value:"123456789012345"},lastResponse:{requestId:"req_payoutRead"}} as unknown as Stripe.Response<Stripe.Payout>;
 const debit={id:"txn_debit",object:"balance_transaction",amount:-5000,fee:0,net:-5000,currency:"usd",balance_type:"payments",exchange_rate:null,source:"po_original",created:now-5,available_on:now-4,status:"available",type:"payout",reporting_category:"payout",fee_details:[],lastResponse:{requestId:"req_payoutDebit"}} as unknown as Stripe.Response<Stripe.BalanceTransaction>;
 const returned={...debit,id:"txn_return",amount:5000,net:5000,type:"payout_failure",reporting_category:"payout_reversal",created:now-2,available_on:now-1,lastResponse:{requestId:"req_payoutReturn"}} as Stripe.Response<Stripe.BalanceTransaction>;
 const account={id:context.platformAccountId,object:"account",country:"US",default_currency:"usd",payouts_enabled:true} as Stripe.Account;
 const settings={object:"balance_settings",payments:{payouts:{status:"enabled",schedule:{interval:"manual"},automatic_transfer_rules_by_currency:{}}}} as unknown as Stripe.BalanceSettings;
 const bank={id:"ba_approved",object:"bank_account",account:context.platformAccountId,customer:null,country:"US",currency:"usd",fingerprint:"fp_bank_fixture",status:"verified"} as unknown as Stripe.BankAccount;
 return {q,payout,debit,returned,account,settings,bank,now};
}
