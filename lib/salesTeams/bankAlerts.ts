import type {BankExceptionState} from "./bankExceptions";
export type BankAlert={alertId:string;kind:"payout_state"|"acknowledged"|"escalated";state:BankExceptionState;
 createdAt:string;readAt:string|null;appliesToCurrentState:boolean};
export type BankAlerts={creatorId:string;scope:"creator"|"closer";membershipStatus:string|null;entries:BankAlert[];hasMore:boolean;nextCursor:string|null;canMarkRead?:boolean};
