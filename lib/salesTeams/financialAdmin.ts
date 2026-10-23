import "server-only";
import {isDeepStrictEqual} from "node:util";
import {teamId} from "./policy";
import {teamRpc} from "./server";
import type {TeamReceiptComposition} from "./receipts";
export type TeamRefundRequestSummary={requestId:string;amountCents:number;responsibility:string;reasonCode:string;dispatchState:string;providerStatus:string|null;refundId:string|null;resolved:boolean;createdAt:string};
export type TeamFinancialAdminRow={receiptId:string;saleId:string;paymentIntentId:string;chargeId:string;revision:number;held:boolean;paidAt:string;subtotalCents:number;refundedCents:number;lossCents:number;processingCostCents:number|null;adjustmentCostCents:number;financialProcessingCreditCents:number;pendingChecks:number;refundRequests?:TeamRefundRequestSummary[];refunds:{id:string;amountCents:number;status:string}[];reviews:{refundId:string;responsibility:string;reasonCode:string}[]};
export async function readTeamFinancialAdmin(c:TeamReceiptComposition,actorId:string,after:string|null){
 teamId(actorId);if(after)teamId(after);
 if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Financial context changed");
 return teamRpc<{mode:string;rows:TeamFinancialAdminRow[];nextCursor:string|null}>(c.admin,"read_sales_team_financial_admin_queue_v1",{p_actor_id:actorId,p_context:c.context,p_after:after,p_limit:20});
}
