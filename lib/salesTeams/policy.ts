export const TEAM_SALES_PROTOCOL = "creatornet-team-distribution-v1" as const;
export const TEAM_COMMISSION_TERMS_VERSION = "creatornet-team-commission-v1" as const;
export type TeamRole = "owner" | "manager" | "closer";
export type RenewalCommission = "initial_commitment" | "every_renewal";
export type TeamEnvironment = Record<string, string | undefined>;

export const teamSchemaReady = (env: TeamEnvironment = process.env) => env.CREATOR_SALES_TEAM_SCHEMA_READY === "true";
export const teamSalesReady = (env: TeamEnvironment = process.env) => teamSchemaReady(env) && env.CREATOR_SALES_TEAM_READY === "true";
export const teamCalendarSchemaReady = (env: TeamEnvironment = process.env) => teamSchemaReady(env) && env.CREATOR_TEAM_CALENDAR_SCHEMA_READY === "true";
export const teamCalendarReady = (env: TeamEnvironment = process.env) => teamCalendarSchemaReady(env) && teamSalesReady(env) && env.CREATOR_TEAM_CALENDAR_READY === "true";
export const teamSaleSchemaReady = (env: TeamEnvironment = process.env) => teamSchemaReady(env) && env.CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY === "true";
export const teamLedgerSchemaReady = (env: TeamEnvironment = process.env) => teamSaleSchemaReady(env) && env.CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY === "true";
export const teamCheckoutReady = (env: TeamEnvironment = process.env) => teamSalesReady(env) && teamSaleSchemaReady(env) && env.CREATOR_TEAM_SALES_CHECKOUT_READY === "true";
export const teamSettlementReady = (env: TeamEnvironment = process.env) => teamLedgerSchemaReady(env) && env.CREATOR_TEAM_SETTLEMENT_READY === "true";
export const teamRecipientSchemaReady = (env: TeamEnvironment = process.env) => teamLedgerSchemaReady(env) && env.CREATOR_TEAM_RECIPIENT_SCHEMA_READY === "true";
export const teamRecipientOnboardingReady = (env: TeamEnvironment = process.env) => teamRecipientSchemaReady(env) && env.CREATOR_TEAM_RECIPIENT_ONBOARDING_READY === "true";
export const teamPaymentSchemaReady = (env: TeamEnvironment = process.env) => teamLedgerSchemaReady(env) && env.CREATOR_TEAM_PAYMENT_SCHEMA_READY === "true";
export const teamPaymentCollectionReady = (env: TeamEnvironment = process.env) => teamPaymentSchemaReady(env) && teamCheckoutReady(env) && env.CREATOR_TEAM_PAYMENT_COLLECTION_READY === "true" && teamReceiptRecordingReady(env) && teamFulfillmentReady(env) && teamEventReconciliationReady(env) && teamFinancialReconciliationReady(env);
export const teamLaterCollectionSchemaReady = (env: TeamEnvironment = process.env) => teamPaymentSchemaReady(env) && env.CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY === "true";
export const teamLaterCollectionReady = (env: TeamEnvironment = process.env) => teamLaterCollectionSchemaReady(env) && env.CREATOR_TEAM_LATER_COLLECTION_READY === "true" && env.CREATOR_TEAM_PAYMENT_COLLECTION_READY === "true" && teamReceiptRecordingReady(env) && teamFulfillmentReady(env) && teamEventReconciliationReady(env) && teamFinancialReconciliationReady(env);
export const teamLifecycleSchemaReady = (env: TeamEnvironment = process.env) => teamLaterCollectionSchemaReady(env) && env.CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY === "true";
export const teamPayoffCollectionReady = (env: TeamEnvironment = process.env) => teamLifecycleSchemaReady(env) && env.CREATOR_TEAM_PAYOFF_COLLECTION_READY === "true" && env.CREATOR_TEAM_PAYMENT_COLLECTION_READY === "true" && teamReceiptRecordingReady(env) && teamFulfillmentReady(env) && teamEventReconciliationReady(env) && teamFinancialReconciliationReady(env);
export const teamCollectionRetrySchemaReady = (env: TeamEnvironment = process.env) => teamLifecycleSchemaReady(env) && env.CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY === "true";
export const teamCollectionRetryReady = (env: TeamEnvironment = process.env) => teamCollectionRetrySchemaReady(env) && env.CREATOR_TEAM_COLLECTION_RETRY_READY === "true" && env.CREATOR_TEAM_PAYMENT_COLLECTION_READY === "true" && teamReceiptRecordingReady(env) && teamFulfillmentReady(env) && teamEventReconciliationReady(env) && teamFinancialReconciliationReady(env);
export const teamSavedMethodSchemaReady = (env: TeamEnvironment = process.env) => teamCollectionRetrySchemaReady(env) && env.CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY === "true";
export const teamSavedMethodReady = (env: TeamEnvironment = process.env) => teamSavedMethodSchemaReady(env) && env.CREATOR_TEAM_SAVED_METHOD_READY === "true" && env.CREATOR_TEAM_PAYMENT_COLLECTION_READY === "true" && teamReceiptRecordingReady(env) && teamFulfillmentReady(env) && teamEventReconciliationReady(env) && teamFinancialReconciliationReady(env);
export const teamAutomaticCollectionSchemaReady = (env: TeamEnvironment = process.env) => teamSavedMethodSchemaReady(env) && env.CREATOR_TEAM_AUTOMATIC_COLLECTION_SCHEMA_READY === "true";
export const teamAutomaticCollectionReady = (env: TeamEnvironment = process.env) => teamAutomaticCollectionSchemaReady(env) && teamSavedMethodReady(env) && teamLaterCollectionReady(env) && env.CREATOR_TEAM_AUTOMATIC_COLLECTION_READY === "true";
export const teamSurplusReservationsSchemaReady = (env: TeamEnvironment = process.env) => teamAutomaticCollectionSchemaReady(env) && teamCashSchemaReady(env) && env.CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY === "true" && env.CREATOR_TEAM_SURPLUS_RESERVATIONS_SCHEMA_READY === "true";
export const teamSurplusReservationsReady = (env: TeamEnvironment = process.env) => teamSurplusReservationsSchemaReady(env) && env.CREATOR_TEAM_SURPLUS_RESERVATIONS_READY === "true";
export const teamSurplusExecutionSchemaReady = (env: TeamEnvironment = process.env) => teamSurplusReservationsSchemaReady(env) && env.CREATOR_TEAM_SURPLUS_EXECUTION_SCHEMA_READY === "true";
export const teamSurplusRecoverySchemaReady = (env: TeamEnvironment = process.env) => teamSurplusExecutionSchemaReady(env) && env.CREATOR_TEAM_SURPLUS_RECOVERY_SCHEMA_READY === "true";
export const teamSurplusEventsSchemaReady = (env: TeamEnvironment = process.env) => teamSurplusRecoverySchemaReady(env) && env.CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY === "true";
export const teamSurplusDailySchemaReady = (env: TeamEnvironment = process.env) => teamSurplusEventsSchemaReady(env) && env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY === "true";
export const teamBeneficiaryPayoutSchemaReady = (env: TeamEnvironment = process.env) => teamSurplusDailySchemaReady(env) && env.CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY === "true";
export const teamPayoutStatementsSchemaReady = (env: TeamEnvironment = process.env) => teamBeneficiaryPayoutSchemaReady(env) && env.CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY === "true";
export const teamSurplusExecutionReady = (env: TeamEnvironment = process.env) => teamSurplusExecutionSchemaReady(env) && teamSurplusReservationsReady(env) && env.CREATOR_TEAM_SURPLUS_EXECUTION_READY === "true";
export const teamReceiptSchemaReady = (env: TeamEnvironment = process.env) => teamPaymentSchemaReady(env) && env.CREATOR_TEAM_RECEIPT_SCHEMA_READY === "true";
export const teamReceiptRecordingReady = (env: TeamEnvironment = process.env) => teamReceiptSchemaReady(env) && env.CREATOR_TEAM_RECEIPT_RECORDING_READY === "true";
export const teamFulfillmentSchemaReady = (env: TeamEnvironment = process.env) => teamReceiptSchemaReady(env) && env.CREATOR_TEAM_FULFILLMENT_SCHEMA_READY === "true";
export const teamFulfillmentReady = (env: TeamEnvironment = process.env) => teamFulfillmentSchemaReady(env) && env.CREATOR_TEAM_FULFILLMENT_READY === "true";
export const teamEventReconciliationReady = (env: TeamEnvironment = process.env) => teamFulfillmentSchemaReady(env) && env.CREATOR_TEAM_EVENT_SCHEMA_READY === "true" && env.CREATOR_TEAM_EVENT_RECONCILIATION_READY === "true";
export const teamFinancialReconciliationReady = (env: TeamEnvironment = process.env) => teamEventReconciliationReady(env) && env.CREATOR_TEAM_FINANCIAL_SCHEMA_READY === "true" && env.CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY === "true";
export const teamRefundReviewReady = (env: TeamEnvironment = process.env) => teamFinancialReconciliationReady(env) && env.CREATOR_TEAM_REFUND_REVIEW_READY === "true";
export const teamBookedOfferSchemaReady = (env: TeamEnvironment = process.env) => teamSaleSchemaReady(env) && env.CREATOR_TEAM_BOOKED_OFFER_SCHEMA_READY === "true";
export const teamRefundDispatchSchemaReady = (env: TeamEnvironment = process.env) => teamReceiptSchemaReady(env) && env.CREATOR_TEAM_EVENT_SCHEMA_READY === "true" && env.CREATOR_TEAM_FINANCIAL_SCHEMA_READY === "true" && env.CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY === "true";
export const teamCashSchemaReady = (env: TeamEnvironment = process.env) => teamRefundDispatchSchemaReady(env) && env.CREATOR_TEAM_CASH_SCHEMA_READY === "true";
export const teamCashFundingReady = (env: TeamEnvironment = process.env) => teamCashSchemaReady(env) && env.CREATOR_TEAM_CASH_FUNDING_READY === "true";
export const teamSharedCashReady = (env: TeamEnvironment = process.env) => teamCashFundingReady(env) && env.CREATOR_TEAM_SHARED_CASH_READY === "true";
export const teamRefundDispatchReady = (env: TeamEnvironment = process.env) => teamRefundDispatchSchemaReady(env) && teamRefundReviewReady(env) && teamSharedCashReady(env) && env.CREATOR_TEAM_REFUND_DISPATCH_READY === "true";
export const teamAutomaticRecoveryReady = (env: TeamEnvironment = process.env) => teamCashSchemaReady(env) && env.CREATOR_TEAM_AUTOMATIC_RECOVERY_SCHEMA_READY === "true" && env.CREATOR_TEAM_AUTOMATIC_RECOVERY_READY === "true";
export const teamAutomaticRefundRecoveryReady = (env: TeamEnvironment = process.env) => teamAutomaticRecoveryReady(env) && env.CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_SCHEMA_READY === "true" && env.CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_READY === "true";
export const teamSharedUnsentRecoveryReady = (env: TeamEnvironment = process.env) => teamAutomaticRecoveryReady(env) && env.CREATOR_TEAM_SHARED_UNSENT_RECOVERY_SCHEMA_READY === "true" && env.CREATOR_TEAM_SHARED_UNSENT_RECOVERY_READY === "true";
export const teamTransferReservationsReady = (env: TeamEnvironment = process.env) => teamCashSchemaReady(env) && teamSettlementReady(env) && env.CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_RESERVATIONS_READY === "true";
export const teamTransferObservationsReady = (env: TeamEnvironment = process.env) => teamCashSchemaReady(env) && env.CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY === "true";
export const teamTransferExecutionReady = (env: TeamEnvironment = process.env) => teamTransferReservationsReady(env) && teamTransferObservationsReady(env) && env.CREATOR_TEAM_TRANSFER_EXECUTION_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_EXECUTION_READY === "true";
export const teamAutomaticSettlementReady = (env: TeamEnvironment = process.env) => teamTransferObservationsReady(env) && env.CREATOR_TEAM_AUTOMATIC_SETTLEMENT_SCHEMA_READY === "true" && env.CREATOR_TEAM_AUTOMATIC_SETTLEMENT_READY === "true";
export const teamTransferReversalObservationsReady = (env: TeamEnvironment = process.env) => teamTransferObservationsReady(env) && env.CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_READY === "true";
export const teamTransferRecoveryReservationsReady = (env: TeamEnvironment = process.env) => teamTransferReversalObservationsReady(env) && env.CREATOR_TEAM_TRANSFER_RECOVERY_RESERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_RECOVERY_RESERVATIONS_READY === "true";
export const teamTransferRecoveryExecutionReady = (env: TeamEnvironment = process.env) => teamTransferRecoveryReservationsReady(env) && env.CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_READY === "true";
export const teamTransferReversalRecoveryReady = (env: TeamEnvironment = process.env) => teamTransferReversalObservationsReady(env) && env.CREATOR_TEAM_TRANSFER_RECOVERY_RESERVATIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_REVERSAL_RECOVERY_SCHEMA_READY === "true" && env.CREATOR_TEAM_TRANSFER_REVERSAL_RECOVERY_READY === "true";
export const teamAutomaticTransferRecoveryReady = (env: TeamEnvironment = process.env) => teamAutomaticSettlementReady(env) && teamTransferReversalRecoveryReady(env) && env.CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY === "true" && env.CREATOR_TEAM_COMBINED_SETTLEMENT_READY === "true";
export type TeamRecipientStatus={status:"not_started"|"verification_required"|"setup_required"|"ready";transfersActive:boolean;payoutsReady:boolean;verifiedAt:string|null};

export class TeamSalesError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message); this.name = "TeamSalesError";
  }
}
export function teamId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new TeamSalesError("INVALID_TEAM_IDENTIFIER", "A valid identifier is required.", 400);
  }
  return value;
}
export function commissionTerms(input: { commissionBps: unknown; holdDays?: unknown; renewals?: unknown }) {
  if (!Number.isInteger(input.commissionBps) || Number(input.commissionBps) < 0 || Number(input.commissionBps) > 8_800) {
    throw new TeamSalesError("INVALID_COMMISSION", "Set an explicit commission percentage between 0% and 88%.", 400);
  }
  const holdDays = input.holdDays ?? 14, renewals = input.renewals ?? "initial_commitment";
  if (!Number.isInteger(holdDays) || Number(holdDays) < 14 || Number(holdDays) > 90 ||
      !["initial_commitment", "every_renewal"].includes(String(renewals))) {
    throw new TeamSalesError("INVALID_COMMISSION_TERMS", "Choose a holding period from 14 to 90 days and a renewal rule.", 400);
  }
  return { version: TEAM_COMMISSION_TERMS_VERSION, commissionBps: input.commissionBps as number,
    holdDays: holdDays as number, renewals: renewals as RenewalCommission };
}

export type MembershipAccess = {
  id: string; creator_id: string; user_id: string; role: "manager" | "closer";
  is_closer: boolean; status: "invited" | "active" | "removed";
  commission_revision: number; accepted_commission_revision: number | null;
};
export function teamRole(creatorId: string, userId: string, member: MembershipAccess | null): TeamRole | null {
  if (creatorId === userId) return "owner";
  if (!member || member.creator_id !== creatorId || member.user_id !== userId || member.status !== "active") return null;
  return member.role;
}
export function canClose(member: MembershipAccess | null, payoutReady: boolean): boolean {
  return !!member && member.status === "active" && member.is_closer && payoutReady &&
    member.accepted_commission_revision === member.commission_revision;
}
export function canManageMember(actor: TeamRole | null, targetRole: "manager" | "closer"): boolean {
  return actor === "owner" || (actor === "manager" && targetRole === "closer");
}

/** Fixed-total choices reuse the existing exact-cent planner; monthly service
 * pricing and duration remain separate. No choice means full payment only. */
export function approvedTeamInstallments(value: unknown, totalCents: number, monthly = false): number[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 23 || (monthly && value.length))
    throw new TeamSalesError("INVALID_APPROVED_OPTIONS", "Choose fixed-total installment counts for this offer.", 400);
  let previous = 1;
  for (const count of value) {
    if (!Number.isInteger(count) || count <= previous || count > 24 ||
        !Number.isSafeInteger(totalCents) || Math.floor(totalCents / count) < 50) {
      throw new TeamSalesError("INVALID_APPROVED_OPTIONS", "Choose ascending payment counts from 2 to 24, at least $0.50 per payment.", 400);
    }
    previous = count;
  }
  return [...value];
}

export const teamBankReviewSchemaReady = (env: TeamEnvironment = process.env) => teamPayoutStatementsSchemaReady(env) && env.CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY === "true";
export const teamBankReviewReady = (env: TeamEnvironment = process.env) => teamBankReviewSchemaReady(env) && env.CREATOR_TEAM_BANK_REVIEW_READY === "true";
export const teamBankQueueSchemaReady = (env: TeamEnvironment = process.env) => teamBankReviewSchemaReady(env) && env.CREATOR_TEAM_BANK_QUEUE_SCHEMA_READY === "true";
export const teamBankReviewActionsSchemaReady = (env: TeamEnvironment = process.env) => teamBankReviewSchemaReady(env) && env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_SCHEMA_READY === "true" && env.CREATOR_TEAM_BANK_REVIEW_ACTION_CONTRACT_SCHEMA_READY === "true";
export const teamBankReviewActionsReady = (env: TeamEnvironment = process.env) => teamBankReviewActionsSchemaReady(env) && teamBankReviewReady(env) && env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_READY === "true";
export const teamBankAlertsSchemaReady = (env: TeamEnvironment = process.env) => teamBankQueueSchemaReady(env) && env.CREATOR_TEAM_BANK_ALERTS_SCHEMA_READY === "true";
export const teamBankAlertsReadReady = (env: TeamEnvironment = process.env) => teamBankAlertsSchemaReady(env) && env.CREATOR_TEAM_BANK_ALERT_READS_READY === "true";
