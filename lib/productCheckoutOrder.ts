import "server-only";
import type {CreatorFeeBreakdown} from "./money";

/** Shared comparison for creation, original attachment and manual-source
 * admission. A mismatched existing order is never rewritten as a new quote. */
export function productCheckoutOrderMatches(order:Record<string,unknown>|null|undefined,expected:{
  orderId:string;buyerId:string|null;creatorId:string;postId:string|null;amountCents:number;currency:string;fees:CreatorFeeBreakdown;
}){
  const {fees}=expected;
  return Boolean(order&&order.id===expected.orderId&&order.buyer_id===expected.buyerId&&order.creator_id===expected.creatorId&&
    (order.post_id??null)===expected.postId&&Number(order.amount_cents)===expected.amountCents&&Number(order.gross_amount)===expected.amountCents&&
    Number(order.platform_fee)===fees.platformFeeCents&&Number(order.processing_fee)===fees.processingFeeCents&&
    Number(order.total_creator_deduction)===fees.totalCreatorDeductionCents&&Number(order.creator_amount)===fees.creatorNetCents&&
    order.fee_schedule_version===fees.feeScheduleVersion&&order.status==="created"&&
    String(order.currency).toLowerCase()===expected.currency.toLowerCase());
}
