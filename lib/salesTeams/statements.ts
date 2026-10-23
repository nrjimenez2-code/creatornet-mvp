export function teamMoney(value:string|number){
 try{
  if(typeof value==="number"&&!Number.isSafeInteger(value))return "Unavailable";
  const cents=BigInt(value),absolute=cents<0n?-cents:cents;
  return `${cents<0n?"-":""}${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(absolute/100n)}.${String(absolute%100n).padStart(2,"0")}`;
 }catch{return "Unavailable";}
}
export const teamStatementStatus:Record<string,string>={holding:"Holding period",financial_review:"Financial review hold",recovery_required:"Commission recovery required",
 no_unpaid_commission:"No unpaid commission",recipient_verification_required:"Recipient verification required",funds_pending:"Funds pending",
 settlement_paused:"Automatic settlement paused",awaiting_settlement:"Awaiting settlement reconciliation"};
export type TeamStatementEntry={receiptId:string;saleId:string;title:string;periodNumber:number;membershipId:string;paidAt:string;earnedCents:number;releasedCents:number;
 reversedCents:number;unpaidCents:number;recoveryCents:number;holdUntil:string;status:string;bankPayoutStatus:string;creatorAccounting:null|{
 saleSubtotalCents:number;refundedSubtotalCents:number;combinedLossSubtotalCents:number;platformRevenueCents:number;creatorProceedsCents:number;creatorTransferredCents:number;
 processingReserveCents:number;actualProcessingCostCents:number;actualFinancialAdjustmentCostCents?:number;financialProcessingCreditCents?:number;platformProcessingCreditCents:number;payoutCostReserveCents:number;creatorDeficitCents:number;taxReserveCents:number}};
export type TeamStatement={creatorId:string;scope:"creator"|"closer";membershipStatus:string|null;currency:"usd";totals:{earnedCents:string;releasedCents:string;
 reversedCents:string;unpaidCents:string;recoveryCents:string};entries:TeamStatementEntry[];nextCursor:string|null;bankPayoutStatus:string};
