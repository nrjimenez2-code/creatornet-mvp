import { PLATFORM_FEE_BPS } from "@/lib/money";

function cents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid nonnegative integer cents");
  return BigInt(value);
}
/** Cumulative rounding makes the total independent of receipt/event ordering. */
export function cumulativeShare(netSubtotalCents: number, basisPoints: number): number {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw Error("Invalid basis points");
  const result = Number((cents(netSubtotalCents) * BigInt(basisPoints) + 5_000n) / 10_000n);
  if (!Number.isSafeInteger(result)) throw Error("Share exceeds supported range");
  return result;
}
export function commissionAdjustment(args: { collectedSubtotalCents: number; refundedSubtotalCents: number;
  commissionBps: number; previouslyEarnedCents: number; releasedCents: number; reversedCents: number }) {
  for (const value of [args.collectedSubtotalCents, args.refundedSubtotalCents, args.previouslyEarnedCents, args.releasedCents, args.reversedCents]) cents(value);
  if (args.refundedSubtotalCents > args.collectedSubtotalCents || args.reversedCents > args.releasedCents) throw Error("Financial observation exceeds original amount");
  const earnedCents = cumulativeShare(args.collectedSubtotalCents - args.refundedSubtotalCents, args.commissionBps);
  const paidCents = args.releasedCents - args.reversedCents;
  return { earnedCents, adjustmentCents: earnedCents - args.previouslyEarnedCents,
    unpaidCents: Math.max(0, earnedCents - paidCents), recoveryCents: Math.max(0, paidCents - earnedCents) };
}

/** Estimates stay reserves until attributable provider cost evidence arrives. */
export function distribution(args: { subtotalCents: number; taxCents: number; refundedSubtotalCents: number;
  commissionBps: number; processingCostCents: number; payoutCostReserveCents: number }) {
  for (const value of [args.subtotalCents, args.taxCents, args.refundedSubtotalCents, args.processingCostCents, args.payoutCostReserveCents]) cents(value);
  if (args.refundedSubtotalCents > args.subtotalCents) throw Error("Refund exceeds collected subtotal");
  const netSubtotalCents = args.subtotalCents - args.refundedSubtotalCents;
  const platformFeeCents = cumulativeShare(netSubtotalCents, PLATFORM_FEE_BPS);
  const commissionCents = cumulativeShare(netSubtotalCents, args.commissionBps);
  const available = netSubtotalCents - platformFeeCents - commissionCents - args.processingCostCents - args.payoutCostReserveCents;
  return { platformFeeCents, commissionCents, taxReserveCents: args.taxCents,
    processingCostCents: args.processingCostCents, payoutCostReserveCents: args.payoutCostReserveCents,
    creatorProceedsCents: Math.max(0, available), creatorDeficitCents: Math.max(0, -available) };
}

/** Largest remainders allocate a shared fee exactly once. Stable creator IDs
 * resolve ties; activity with zero weight never receives a charge. */
export function allocateSharedCost(totalCents: number, activity: readonly { creatorId: string; weightCents: number }[]) {
  const total = cents(totalCents), ids = new Set<string>();
  const rows = activity.map(item => {
    if (!item.creatorId || ids.has(item.creatorId)) throw Error("Duplicate or missing creator");
    ids.add(item.creatorId); return { ...item, weight: cents(item.weightCents), allocationCents: 0, remainder: 0n };
  });
  const weight = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (weight === 0n) { if (total > 0n) throw Error("Shared cost requires contributing activity"); return rows.map(({creatorId})=>({creatorId,amountCents:0})); }
  let allocated = 0n;
  for (const row of rows) {
    const numerator = total * row.weight;
    row.allocationCents = Number(numerator / weight); row.remainder = numerator % weight; allocated += numerator / weight;
  }
  const ranked = [...rows].filter(row=>row.weight>0n).sort((a,b)=>a.remainder===b.remainder ? a.creatorId.localeCompare(b.creatorId) : a.remainder>b.remainder ? -1 : 1);
  for (let i=0; BigInt(i)<total-allocated; i++) ranked[i].allocationCents++;
  return rows.map(row=>({creatorId:row.creatorId,amountCents:row.allocationCents}));
}

/** Protect all outstanding obligations before a platform surplus withdrawal. */
export function withdrawableSurplus(availableCents: number, obligationsCents: number, reserveCents: number): number {
  cents(availableCents); cents(obligationsCents); cents(reserveCents);
  return Math.max(0, availableCents - obligationsCents - reserveCents);
}
