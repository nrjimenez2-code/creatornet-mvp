import type {SharedCashOriginal} from "@/lib/salesTeams/sharedCashReadback";

/** Synthetic GET-only transport for integrated SQL/reader checks. It is not
 * evidence about any real Stripe account, transaction, reserve or fee rate. */
export function sharedCashOriginalFixture(s:SharedCashOriginal){
 const stamp=Math.floor(Date.now()/1000)-1;
 const balance=(id:string,source:string,type:string,amount:number,fee=0)=>({id,object:"balance_transaction",source,type,amount,fee,net:amount-fee,currency:"usd",exchange_rate:null,balance_type:"payments",created:stamp,available_on:stamp,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]});
 const values:Record<string,Record<string,unknown>>={
  [`/v1/charges/${s.chargeId}`]:{object:"charge",id:s.chargeId,payment_intent:s.paymentIntentId,livemode:s.context.mode==="live",currency:"usd",paid:true,captured:true,status:"succeeded",
   amount:s.kind==="legacy_refund"?s.grossCents:1000,application_fee:s.kind==="legacy_refund"?s.applicationFeeId:null,transfer:s.kind==="tip_restoration"?s.originalTransferId:"tr_legacy",transfer_data:{destination:s.kind==="tip_restoration"?s.destinationId:"acct_legacy"}},
 };
 if(s.kind==="legacy_refund"){
  values[`/v1/refunds/${s.refundId}`]={object:"refund",id:s.refundId,charge:s.chargeId,payment_intent:s.paymentIntentId,amount:s.refundCents,currency:"usd",status:"succeeded",created:stamp,balance_transaction:"txn_refund",failure_balance_transaction:null,metadata:{creatornet_refund_operation_id:s.id,responsibility:s.responsibility,reason_code:s.reasonCode}};
  values["/v1/balance_transactions/txn_refund"]=balance("txn_refund",s.refundId!,"refund",-s.refundCents,40);
  if(s.feeRefundId){
   values[`/v1/application_fees/${s.applicationFeeId}`]={object:"application_fee",id:s.applicationFeeId,charge:s.chargeId,account:"acct_legacy",currency:"usd",livemode:s.context.mode==="live",amount:1520,amount_refunded:s.actualFeeRefundCents};
   values[`/v1/application_fees/${s.applicationFeeId}/refunds/${s.feeRefundId}`]={object:"fee_refund",id:s.feeRefundId,fee:s.applicationFeeId,amount:s.actualFeeRefundCents,currency:"usd",created:stamp,balance_transaction:"txn_fee",metadata:{creatornet_refund_operation_id:s.id,responsibility:s.responsibility}};
   values["/v1/balance_transactions/txn_fee"]=balance("txn_fee",s.feeRefundId,"application_fee_refund",-s.actualFeeRefundCents!);
  }
 }else{
  values[`/v1/disputes/${s.disputeId}`]={object:"dispute",id:s.disputeId,charge:s.chargeId,payment_intent:s.paymentIntentId,currency:"usd",livemode:s.context.mode==="live",status:"won"};
  values[`/v1/transfers/${s.restorationTransferId}`]={object:"transfer",id:s.restorationTransferId,amount:s.restorationCents,currency:"usd",livemode:s.context.mode==="live",destination:s.destinationId,source_transaction:null,source_type:"card",transfer_group:`creatornet-tip-dispute-restore:${s.disputeId}`,created:stamp,balance_transaction:"txn_restored",metadata:{payment_kind:"video_tip_dispute_restoration",tip_id:s.tipId,dispute_id:s.disputeId}};
  values["/v1/balance_transactions/txn_restored"]=balance("txn_restored",s.restorationTransferId!,"transfer",-s.restorationCents);
 }
 let count=0;
 const raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||!values[path])throw Error("Only owned original GETs permitted in fixture");return {...structuredClone(values[path]),lastResponse:{requestId:`req_integrated${++count}`}};});
 return {values,raw};
}
