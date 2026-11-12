import { calculateRefundAllocation,reasonMatchesResponsibility,type RefundReasonCode,type RefundResponsibility } from "@/lib/refundAllocation";
import { cumulativeShare } from "./accounting";

type Refund={id:string;chargeId:string;amountCents:number;status:"succeeded"|"pending"|"failed"|"canceled"|"requires_action";created:number};
type Decision={refundId:string;chargeId:string;responsibility:RefundResponsibility;reasonCode:RefundReasonCode};
type Dispute={id:string;chargeId:string;amountCents:number;status:"warning_needs_response"|"warning_under_review"|"warning_closed"|"needs_response"|"under_review"|"won"|"lost"|"prevented"};
const validCents=(n:number)=>Number.isSafeInteger(n)&&n>=0;
/** All objects/decisions are independently verified service reads. A mixed
 * partial refund/dispute without a reconciled principal trace remains held;
 * event amounts are never blindly added to manufacture another loss. */
export function observeTeamFinancialState(args:{chargeId:string;subtotalCents:number;chargeRefundedCents:number;actualProcessingCostCents:number|null;
 refunds:readonly Refund[];refundListComplete:boolean;decisions:readonly Decision[];disputes:readonly Dispute[];
 verifiedCombinedLoss?:{subtotalCents:number;providerEvidenceIds:readonly string[]}}){
 if(!/^ch_[A-Za-z0-9]+$/.test(args.chargeId)||!validCents(args.subtotalCents)||args.subtotalCents<50||!validCents(args.chargeRefundedCents)||args.chargeRefundedCents>args.subtotalCents||
  args.actualProcessingCostCents!==null&&!validCents(args.actualProcessingCostCents))throw Error("Invalid owned charge evidence");
 const alerts:string[]=[],refunds=new Map<string,Refund>(),decisions=new Map<string,Decision>();
 for(const refund of args.refunds){
  if(refund.chargeId!==args.chargeId||!/^re_[A-Za-z0-9]+$/.test(refund.id)||refunds.has(refund.id)||!validCents(refund.amountCents)||refund.amountCents===0||
   refund.amountCents>args.subtotalCents||!Number.isSafeInteger(refund.created)||refund.created<=0)throw Error("Refund identity or amount differs");
  refunds.set(refund.id,refund);
  if(!["succeeded","pending","failed","canceled","requires_action"].includes(refund.status))throw Error("Unknown refund state requires review");
 }
 for(const decision of args.decisions){if(decision.chargeId!==args.chargeId||decisions.has(decision.refundId)||!reasonMatchesResponsibility(decision.reasonCode,decision.responsibility))throw Error("Refund responsibility requires review");decisions.set(decision.refundId,decision);}
 const successful=[...refunds.values()].filter(r=>r.status==="succeeded").sort((a,b)=>a.created-b.created||(a.id<b.id?-1:a.id>b.id?1:0));
 const listedRefundedCents=successful.reduce((sum,r)=>sum+r.amountCents,0);
 if(listedRefundedCents>args.subtotalCents)throw Error("Confirmed refunds exceed the charge");
 // A bounded/incomplete list cannot restore commission on principal the
 // independently retrieved original charge already confirms was refunded.
 const refundedCents=Math.max(listedRefundedCents,args.chargeRefundedCents);
 if(!args.refundListComplete||listedRefundedCents!==args.chargeRefundedCents)alerts.push("REFUND_TOTAL_UNRECONCILED");
 if([...refunds.values()].some(r=>r.status==="pending"||r.status==="requires_action"))alerts.push("REFUND_PENDING");
 let totalLossCents=refundedCents,disputeHold=false;
 const disputeIds=new Set<string>();
 for(const dispute of args.disputes){
  if(dispute.chargeId!==args.chargeId||!/^du_[A-Za-z0-9]+$/.test(dispute.id)||disputeIds.has(dispute.id)||!validCents(dispute.amountCents)||dispute.amountCents<=0||dispute.amountCents>args.subtotalCents)throw Error("Dispute identity or amount differs");
  disputeIds.add(dispute.id);
  if(!["warning_needs_response","warning_under_review","warning_closed","needs_response","under_review","won","lost","prevented"].includes(dispute.status))throw Error("Unknown dispute state requires review");
  if(["warning_needs_response","warning_under_review","needs_response","under_review"].includes(dispute.status))disputeHold=true;
  if(dispute.status==="lost"){
   if(dispute.amountCents===args.subtotalCents)totalLossCents=args.subtotalCents;
   else if(refundedCents===0&&args.disputes.length===1)totalLossCents=dispute.amountCents;
   else {totalLossCents=Math.max(totalLossCents,dispute.amountCents);alerts.push("REFUND_DISPUTE_PRINCIPAL_RECONCILIATION_REQUIRED");}
  }
 }
 if(args.verifiedCombinedLoss){
  const proof=args.verifiedCombinedLoss;
  if(!validCents(proof.subtotalCents)||proof.subtotalCents<totalLossCents||proof.subtotalCents>args.subtotalCents||!proof.providerEvidenceIds.length||
   proof.providerEvidenceIds.some(v=>!/^txn_[A-Za-z0-9]+$/.test(v)))throw Error("Combined principal trace is invalid");
  totalLossCents=proof.subtotalCents;
  const index=alerts.indexOf("REFUND_DISPUTE_PRINCIPAL_RECONCILIATION_REQUIRED");if(index>=0)alerts.splice(index,1);
 }
 const platformFeeCents=cumulativeShare(args.subtotalCents,1200),processing=args.actualProcessingCostCents??0;
 let prior=0,feeReturned=0,platformFeeReturnedCents=0,platformProcessingCostCreditCents=0;
 if(processing+platformFeeCents>args.subtotalCents)alerts.push("PROCESSING_COST_DEFICIT_REQUIRES_REVIEW");
 else{
  for(const refund of successful){
   const decision=decisions.get(refund.id);if(!decision)alerts.push("REFUND_RESPONSIBILITY_UNREVIEWED");
   const allocation=calculateRefundAllocation({grossAmountCents:args.subtotalCents,platformFeeCents,processingFeeCents:processing,
    creatorNetCents:args.subtotalCents-platformFeeCents-processing,refundedBeforeCents:prior,applicationFeeRefundedBeforeCents:feeReturned,
    requestedRefundAmountCents:refund.amountCents,responsibility:decision?.responsibility??"creator"});
   prior+=refund.amountCents;feeReturned=allocation.applicationFeeRefundTargetCents;platformFeeReturnedCents+=allocation.platformFeeRefundCents;
   if(decision?.responsibility==="platform")platformProcessingCostCreditCents+=allocation.processingFeeAllocationCents;
  }
  if(totalLossCents>refundedCents){
   const loss=calculateRefundAllocation({grossAmountCents:args.subtotalCents,platformFeeCents,processingFeeCents:processing,
    creatorNetCents:args.subtotalCents-platformFeeCents-processing,refundedBeforeCents:prior,applicationFeeRefundedBeforeCents:feeReturned,
    requestedRefundAmountCents:totalLossCents-refundedCents,responsibility:"creator"});platformFeeReturnedCents+=loss.platformFeeRefundCents;
  }
 }
 if(successful.length&&args.actualProcessingCostCents===null)alerts.push("REFUND_PROCESSING_COST_UNVERIFIED");
 return {refundedCents,totalLossCents,disputeHold,reviewHold:alerts.length>0,platformFeeReturnedCents,platformProcessingCostCreditCents,alerts:[...new Set(alerts)]};
}
