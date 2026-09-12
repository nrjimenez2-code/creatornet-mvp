import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";

type Period = Readonly<{ number: number; start: number; end: number; invoiceId: string | null; admitted: boolean; counted: boolean }>;
export interface ExactDiscoveryStore { periods(agreementId: string): Promise<ReadonlyArray<Period>> }
export type DiscoveryResult = Readonly<{ status: "nothing_due" | "review_required" | "waiting_for_invoice" }> |
  Readonly<{ status: "discovered" | "reconcile_admitted"; invoiceId: string; paymentNumber: number }>;

export function createExactDiscoveryStore(admin: SupabaseClient): ExactDiscoveryStore {
  return { async periods(agreementId) {
    assertAgreementId(agreementId);
    const [periods, claims, receipts] = await Promise.all([
      admin.from("exact_installment_periods").select("agreement_id,payment_number,due_at,period_end").eq("agreement_id", agreementId).order("payment_number").limit(25),
      admin.from("exact_installment_invoice_claims").select("agreement_id,payment_number,stripe_invoice_id,dispatch_started_at").eq("agreement_id", agreementId).limit(25),
      admin.from("exact_installment_receipts").select("agreement_id,payment_number,counted_at").eq("agreement_id", agreementId).limit(25),
    ]);
    if ([periods, claims, receipts].some(r => r.error || !Array.isArray(r.data) || r.data.length >= 25 ||
      r.data.some(v => v.agreement_id !== agreementId))) throw new Error("Invoice discovery state unavailable");
    const seen = new Set<number>();
    return periods.data!.map(p => {
      if (!Number.isInteger(p.payment_number) || p.payment_number < 2 || p.payment_number > 24 || seen.has(p.payment_number) ||
        !Number.isSafeInteger(p.due_at) || !Number.isSafeInteger(p.period_end) || p.due_at <= 0 || p.due_at >= p.period_end) {
        throw new Error("Invalid saved invoice period");
      }
      seen.add(p.payment_number);
      const c = claims.data!.filter(c => c.payment_number === p.payment_number);
      const r = receipts.data!.filter(r => r.payment_number === p.payment_number);
      if (c.length > 1 || r.length > 1 || c[0] && !/^in_[a-zA-Z0-9]+$/.test(c[0].stripe_invoice_id)) throw new Error("Ambiguous saved invoice");
      return { number:p.payment_number as number, start:p.due_at as number, end:p.period_end as number,
        invoiceId:(c[0]?.stripe_invoice_id ?? null) as string | null, admitted:c[0]?.dispatch_started_at != null, counted:r[0]?.counted_at != null };
    });
  } };
}

/** Read-only per-plan discovery for a future bounded worker. A returned invoice
 * is NOT payment permission: the existing collector must re-retrieve and acquire
 * its durable claim. There is no cron, automatic catch-up debit, pay(), or new
 * webhook event fabricated here. Old admitted payments remain reconciliation.
 * The full subscription invoice list is checked before choosing any candidate. */
export async function discoverExactRenewalSandbox(args: {
  agreementId: string; store: ExactAgreementStore; discoveryStore: ExactDiscoveryStore;
  stripe: Pick<Stripe,"invoices">; env: Record<string,string|undefined>; now?: () => number;
}): Promise<DiscoveryResult> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  if (args.env.CREATOR_EXACT_INSTALLMENTS_DISCOVERY_READY !== "true" || args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY !== "true") {
    throw new Error("Invoice discovery not enabled");
  }
  assertAgreementId(args.agreementId);
  const a = await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  if (a.id !== args.agreementId || !a.subscriptionId || !a.customerId) throw new Error("Invoice discovery binding differs");
  return discoverExactRenewalUsingBinding({ binding: a, discoveryStore: args.discoveryStore,
    stripe: args.stripe, expectedLiveMode: false, now: args.now });
}

/** #3 shared read-only discovery. The context caller supplies its independently
 * validated persisted binding; the existing collector still owns every claim. */
export async function discoverExactRenewalUsingBinding(args: {
  binding: { id: string; subscriptionId: string | null; customerId: string | null; status: string; terms: { paymentCount: number } };
  discoveryStore: ExactDiscoveryStore; stripe: Pick<Stripe, "invoices">; expectedLiveMode: boolean; now?: () => number;
}): Promise<DiscoveryResult> {
  const a = args.binding;
  assertAgreementId(a.id);
  if (!a.subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(a.subscriptionId) || !a.customerId || !/^cus_[A-Za-z0-9]+$/.test(a.customerId) ||
      !Number.isInteger(a.terms.paymentCount) || a.terms.paymentCount < 2 || a.terms.paymentCount > 24) throw Error("Invoice discovery binding differs");
  if (!["active","complete","review_required"].includes(a.status)) return {status:"nothing_due"};
  const now = (args.now ?? (()=>Math.floor(Date.now()/1000)))();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid discovery time");
  const periods = await args.discoveryStore.periods(a.id);
  if (periods.length !== a.terms.paymentCount-1 || periods.some((p,i)=>p.number!==i+2 || i>0 && p.start!==periods[i-1].end)) {
    return {status:"review_required"};
  }
  // Never skip an earlier unpaid period to charge a later installment.
  const target = periods.find(p=>!p.counted);
  if (!target || target.start > now) return {status:"nothing_due"};
  if (!target.admitted && (a.status!=="active" || now>=target.end)) return {status:"review_required"};
  const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
  let cursor:string|undefined;
  const seen = new Set<string>(); const matching:Stripe.Invoice[]=[];
  for (let pageNo=0;;pageNo++) {
    if (pageNo>=10) return {status:"review_required"};
    let page:Stripe.ApiList<Stripe.Invoice>;
    try {page=await args.stripe.invoices.list({subscription:a.subscriptionId,limit:100,...(cursor?{starting_after:cursor}:{})});}
    catch {throw new Error("Invoice discovery provider evidence unavailable");}
    for (const invoice of page.data) {
      if (!/^in_[a-zA-Z0-9]+$/.test(invoice.id) || seen.has(invoice.id) || invoice.livemode!==args.expectedLiveMode ||
        id(invoice.customer)!==a.customerId || id(invoice.parent?.subscription_details?.subscription)!==a.subscriptionId ||
        invoice.currency!=="usd" || invoice.lines.has_more) return {status:"review_required"};
      seen.add(invoice.id);
      if(invoice.billing_reason==="subscription_create") continue; // never count the bootstrap as an installment
      if(invoice.billing_reason!=="subscription_cycle") return {status:"review_required"};
      const lines=invoice.lines.data.filter(l=>l.parent?.type==="subscription_item_details");
      if(lines.length!==1 || lines[0].parent?.subscription_item_details?.proration!==false) return {status:"review_required"};
      if(lines[0].period.start===target.start && lines[0].period.end===target.end) matching.push(invoice);
    }
    if (!page.has_more) break;
    const next=page.data.at(-1)?.id;if(!next || next===cursor) return {status:"review_required"};cursor=next;
  }
  if (matching.length===0) return {status:target.invoiceId?"review_required":"waiting_for_invoice"};
  if (matching.length!==1 || target.invoiceId && matching[0].id!==target.invoiceId) return {status:"review_required"};
  if(target.admitted) return {status:"reconcile_admitted",invoiceId:matching[0].id,paymentNumber:target.number};
  if(!["draft","open"].includes(matching[0].status ?? "") || matching[0].auto_advance!==false || matching[0].amount_paid!==0) {
    return {status:"review_required"};
  }
  return {status:"discovered",invoiceId:matching[0].id,paymentNumber:target.number};
}
