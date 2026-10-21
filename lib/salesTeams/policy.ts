export const TEAM_SALES_PROTOCOL = "creatornet-team-distribution-v1" as const;
export const TEAM_COMMISSION_TERMS_VERSION = "creatornet-team-commission-v1" as const;
export type TeamRole = "owner" | "manager" | "closer";
export type RenewalCommission = "initial_commitment" | "every_renewal";
export type TeamEnvironment = Record<string, string | undefined>;

export const teamSchemaReady = (env: TeamEnvironment = process.env) => env.CREATOR_SALES_TEAM_SCHEMA_READY === "true";
export const teamSalesReady = (env: TeamEnvironment = process.env) => teamSchemaReady(env) && env.CREATOR_SALES_TEAM_READY === "true";
export const teamSaleSchemaReady = (env: TeamEnvironment = process.env) => teamSchemaReady(env) && env.CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY === "true";
export const teamLedgerSchemaReady = (env: TeamEnvironment = process.env) => teamSaleSchemaReady(env) && env.CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY === "true";
export const teamCheckoutReady = (env: TeamEnvironment = process.env) => teamSalesReady(env) && teamSaleSchemaReady(env) && env.CREATOR_TEAM_SALES_CHECKOUT_READY === "true";
export const teamSettlementReady = (env: TeamEnvironment = process.env) => teamLedgerSchemaReady(env) && env.CREATOR_TEAM_SETTLEMENT_READY === "true";

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
