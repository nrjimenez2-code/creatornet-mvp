import "server-only";
import { membershipAgreementFingerprint } from "@/lib/membershipAgreement";
import { calculateInstallmentPlan } from "@/lib/installmentPlan";
import { productPurchaseTerms, type ConsentProduct } from "@/lib/purchaseConsent";
import { PURCHASE_POLICY, PURCHASE_POLICY_VERSION } from "@/lib/purchasePolicies";
import { readMonthlyMentorshipTerms, describeMonthlyMentorship } from "@/lib/membershipTerms";
import { PLATFORM_FEE_BPS, calculateCreatorFees, type ProcessingFeeSchedule } from "@/lib/money";
import { commissionTerms, TEAM_SALES_PROTOCOL, teamId, TeamSalesError } from "./policy";
import type { ExactPaymentContext } from "@/lib/installments/paymentContext";

export type TeamOfferOption={id:string;approvalId:string;creatorId:string;productId:string;kind:"full"|"installments"|"monthly";
 amountCents:number;paymentCount:number;revision:number;sourceSnapshot:Record<string,unknown>};
export type TeamSaleTerms=ReturnType<typeof buildTeamSaleAgreement>["terms"];
export type TeamSaleSource={booking:{id:string;buyerId:string;creatorId:string;postId:string};
 assignment:{membershipId:string;closerId:string;actingUserId:string;revision:number};
 commission:{commissionBps:number;holdDays:number;renewals:"initial_commitment"|"every_renewal";revision:number};
 option:TeamOfferOption;product:ConsentProduct;creatorRecipientId:string;closerRecipientId:string;
 financialConfig:{context:ExactPaymentContext;processingFees:ProcessingFeeSchedule;payoutCostEstimateCents:number;
 feeDisclosureVersion:string;commissionDisclosureVersion:string;revision:number}};
export function quoteTeamSale(source:TeamSaleSource,saleId:string){
 return buildTeamSaleAgreement({saleId,bookingId:source.booking.id,buyerId:source.booking.buyerId,creatorId:source.booking.creatorId,postId:source.booking.postId,
  membershipId:source.assignment.membershipId,closerId:source.assignment.closerId,actingUserId:source.assignment.actingUserId,
  assignmentRevision:source.assignment.revision,commissionRevision:source.commission.revision,...source.commission,
  creatorRecipientId:source.creatorRecipientId,closerRecipientId:source.closerRecipientId,option:source.option,product:source.product,...source.financialConfig});
}
export function publicTeamSaleTerms(terms:TeamSaleTerms){
 return {version:terms.version,protocol:terms.protocol,saleId:terms.saleId,title:terms.title,description:terms.description,
  amountCents:terms.amountCents,currency:terms.currency,billing:terms.billing,purchaseKind:terms.kind,paymentKind:terms.paymentKind,payments:terms.payments,
  policy:terms.policy,...("serviceDescription" in terms?{serviceDescription:terms.serviceDescription}:{}),
  ...("monthlyTerms" in terms?{monthlyTerms:terms.monthlyTerms}:{})};
}
/** The input is assembled from server-owned booking, approval, membership,
 * pricing and verified-recipient reads. A caller supplies only saved IDs. */
export function buildTeamSaleAgreement(args:{
 saleId:string;bookingId:string;buyerId:string;creatorId:string;postId:string;
 membershipId:string;closerId:string;actingUserId:string;assignmentRevision:number;commissionRevision:number;
 commissionBps:number;holdDays:number;renewals:"initial_commitment"|"every_renewal";
 creatorRecipientId:string;closerRecipientId:string;option:TeamOfferOption;
 product:ConsentProduct;processingFees:ProcessingFeeSchedule;payoutCostEstimateCents:number;
 feeDisclosureVersion:string;commissionDisclosureVersion:string;
}){
 for(const value of [args.saleId,args.bookingId,args.buyerId,args.creatorId,args.postId,args.membershipId,args.closerId,args.actingUserId,args.option.id,args.option.approvalId,args.option.productId])teamId(value);
 const option=args.option,product=args.product;
 if(args.buyerId===args.creatorId||args.buyerId===args.closerId||product.creator_id!==args.creatorId||product.id!==option.productId||
   option.creatorId!==args.creatorId||!["video","course","mentorship","bundle","call"].includes(product.type||"")||
   !Number.isSafeInteger(option.amountCents)||option.amountCents<50||option.amountCents>99999999||
   !Number.isSafeInteger(args.assignmentRevision)||args.assignmentRevision<1||!Number.isSafeInteger(args.commissionRevision)||args.commissionRevision<1||
   !Number.isSafeInteger(option.revision)||option.revision<1||!Number.isSafeInteger(args.payoutCostEstimateCents)||args.payoutCostEstimateCents<0||
   !args.feeDisclosureVersion||!args.commissionDisclosureVersion||
   !/^acct_[A-Za-z0-9]+$/.test(args.creatorRecipientId)||!/^acct_[A-Za-z0-9]+$/.test(args.closerRecipientId)||args.creatorRecipientId===args.closerRecipientId)
   throw new TeamSalesError("TEAM_SALE_BINDING_INVALID","This sale's offer or recipients need review.");
 const commission=commissionTerms({commissionBps:args.commissionBps,holdDays:args.holdDays,renewals:args.renewals});
 const monthly=readMonthlyMentorshipTerms(product.membership_terms,product.type);
 if((option.kind==="monthly")!==!!monthly||option.kind!=="installments"&&option.paymentCount!==1)
   throw new TeamSalesError("TEAM_OPTION_INVALID","The selected option does not match the booked offer.");
 const base=monthly?{version:PURCHASE_POLICY_VERSION,kind:"monthly" as const,buyerId:args.buyerId,creatorId:args.creatorId,
   productId:product.id,postId:args.postId,title:String(product.title||"Monthly service"),description:String(product.description||""),
   amountCents:option.amountCents,currency:"usd" as const,billing:describeMonthlyMentorship(option.amountCents,monthly),policy:PURCHASE_POLICY}
   : productPurchaseTerms({...product,amount_cents:option.amountCents,price_cents:option.amountCents},args.buyerId,args.postId).terms;
 const payments=option.kind==="installments"?calculateInstallmentPlan(option.amountCents,option.paymentCount,args.processingFees).payments.map(p=>({number:p.number,amountCents:p.amountCents}))
   :[{number:1,amountCents:option.amountCents}];
 if(payments.some(p=>calculateCreatorFees(p.amountCents,args.processingFees).creatorNetCents-
   Number((BigInt(p.amountCents)*BigInt(commission.commissionBps)+5000n)/10000n)-args.payoutCostEstimateCents<0))
   throw new TeamSalesError("TEAM_SALE_RESERVE_DEFICIT","The approved sale does not cover its commission and disclosed costs.");
 const terms={...base,protocol:TEAM_SALES_PROTOCOL,saleId:args.saleId,bookingId:args.bookingId,
   membershipId:args.membershipId,closerId:args.closerId,actingUserId:args.actingUserId,
   assignmentRevision:args.assignmentRevision,commissionRevision:args.commissionRevision,
   optionId:option.id,approvalId:option.approvalId,offerRevision:option.revision,
   paymentKind:option.kind,paymentCount:option.paymentCount,payments,
   ...(monthly?{monthlyTerms:monthly,initialCommitmentMonths:monthly.minimumMonths}:{}),
   billing:option.kind==="installments"?"One fixed purchase total. The first payment is due at checkout; remaining payments are monthly. The final payment includes any remaining cents. Payments stop after the agreed total. This does not create an ongoing membership or change service duration.":base.billing,
   commission,distribution:{version:TEAM_SALES_PROTOCOL,chargeType:"separate_charges_and_transfers" as const,platformFeeBps:PLATFORM_FEE_BPS,
     creatorRecipientId:args.creatorRecipientId,closerRecipientId:args.closerRecipientId,processingFees:{...args.processingFees},
     payoutCostEstimateCents:args.payoutCostEstimateCents,feeDisclosureVersion:args.feeDisclosureVersion,commissionDisclosureVersion:args.commissionDisclosureVersion,
     costsFundedBy:"creator" as const,excessReserve:"return_to_creator" as const,shortfall:"creator_balance_without_bank_debit" as const},
 };
 return {terms,fingerprint:membershipAgreementFingerprint(terms)};
}

export function commissionAppliesToPeriod(terms:Pick<TeamSaleTerms,"commission"|"paymentKind">&{initialCommitmentMonths?:number},period:number){
 if(!Number.isSafeInteger(period)||period<1)throw Error("Invalid paid service period");
 return terms.paymentKind!=="monthly"||terms.commission.renewals==="every_renewal"||period<=(terms.initialCommitmentMonths??1);
}
