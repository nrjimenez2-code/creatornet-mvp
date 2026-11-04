export type BankExceptionState={
 requestId:string;creatorId:string;beneficiary:"creator"|"closer";transferredCents:string;transferredAt:string;
 reversedCents:string;payoutStatus:string;observedAt:string|null;reason:string;bankConfirmed:false;outstanding:true
};
export type BankExceptionReview={reviewId:string;reviewedAt:string;actorRole:string;action:string;appliesToCurrentState:boolean};
export type BankExceptionQueue={creatorId:string;scope:"creator"|"closer";membershipStatus:string|null;
 entries:Array<{state:BankExceptionState;latestReview:BankExceptionReview|null}>;hasMore:boolean;nextCursor:string|null;readAt:string};
export type BankExceptionDetail={state:BankExceptionState;stateSha256:string;history:BankExceptionReview[];hasMoreHistory:boolean;nextCursor:string|null;canReview?:boolean};
export const bankExceptionReasons:Record<string,string>={transfer_reversed:"Transfer reversal recorded",payout_observation_missing:"No payout observation recorded",
 payout_failed:"Stripe payout reported failed",payout_canceled:"Stripe payout reported canceled",bank_confirmation_pending:"Awaiting bank confirmation"};
