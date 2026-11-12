import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mentorshipInstallmentQuote } from "./mentorshipInstallmentQuote";
import { assertAgreementId, operationHash } from "./installments/agreementStore";
import { validateExactPaymentContext } from "./installments/paymentContext";

type QuoteArgs = Parameters<typeof mentorshipInstallmentQuote>[0];
type AcceptedTerms = ReturnType<typeof mentorshipInstallmentQuote>["terms"];
function check(value: unknown): asserts value { if (!value) throw Error("Installment acceptance needs review"); }
function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).every(key => typeof key === "string" && "value" in descriptors[key] && descriptors[key].enumerable));
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string { check(typeof value === "string"); assertAgreementId(value); return value; }

/** Recover the original accepted quote without consulting a changed catalog or
 * changing fee snapshots. The original serialized text makes its fingerprint
 * verifiable after JSONB reorders keys. No payment authority is returned. */
export async function readBuyerMentorshipInstallmentReservation(args: {
  admin: SupabaseClient; buyerId: string; requestId: string; context: unknown; contextEvidence: unknown;
}) {
  try {
    const context = validateExactPaymentContext(args.context, args.contextEvidence);
    const buyerId = uuid(args.buyerId), requestId = uuid(args.requestId);
    const { data, error } = await args.admin.from("buyer_mentorship_installment_reservations_v1")
      .select("id,request_id,attempt_id,buyer_id,creator_id,product_id,post_id,context,terms,terms_text,fingerprint,status,accepted_at")
      .eq("request_id", requestId).eq("buyer_id", buyerId).contains("context", context).maybeSingle();
    check(!error);
    if (!data) return null;
    const row = record(data);
    uuid(row.id); uuid(row.attempt_id); uuid(row.creator_id); uuid(row.product_id); uuid(row.post_id);
    validateExactPaymentContext(row.context, args.contextEvidence);
    check(row.buyer_id === buyerId && row.request_id === requestId && row.status === "reserved" &&
      typeof row.terms_text === "string" && row.terms_text.length <= 100000 && typeof row.fingerprint === "string" &&
      createHash("sha256").update(row.terms_text).digest("hex") === row.fingerprint &&
      typeof row.accepted_at === "string" && Number.isFinite(Date.parse(row.accepted_at)) && Date.parse(row.accepted_at) > 0);
    const parsed = record(JSON.parse(row.terms_text));
    check(operationHash(parsed) === operationHash(row.terms));
    const t = parsed as AcceptedTerms;
    check(t.buyerId === buyerId && t.creatorId === row.creator_id && t.productId === row.product_id && t.postId === row.post_id);
    const reconstructed = mentorshipInstallmentQuote({ buyerId, postId: t.postId, paymentCount: t.paymentCount,
      firstPaymentFees: t.firstPaymentFeeSchedule, renewalFees: t.renewalFeeSchedule,
      product: { id: t.productId, creator_id: t.creatorId, type: "mentorship", title: t.title, description: t.description,
        amount_cents: t.amountCents, currency: t.currency, fixed_service_months: t.serviceMonths, installment_options: [t.paymentCount] } });
    check(operationHash(reconstructed.terms) === operationHash(parsed));
    let releasedAt:string|null|undefined;
    if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY==="true"){
      const release=await args.admin.from("buyer_mentorship_installment_reservations_v1").select("id,request_id,buyer_id,released_at")
        .eq("id",row.id as string).eq("request_id",requestId).eq("buyer_id",buyerId).contains("context",context).maybeSingle();
      check(!release.error&&release.data);
      check(release.data.id===row.id&&release.data.request_id===requestId&&release.data.buyer_id===buyerId);
      const at=release.data.released_at;
      check(at===null || typeof at==="string"&&Number.isFinite(Date.parse(at))&&Date.parse(at)>=Date.parse(row.accepted_at)&&Date.parse(at)<=Date.now()+5000);
      releasedAt=at;
    }
    return { requestId, status: "reserved" as const, fingerprint: row.fingerprint, terms: t,
      acceptedAt: row.accepted_at, providerOperationsAllowed: false as const,...(releasedAt===undefined?{}:{releasedAt}) };
  } catch { throw Error("Saved installment acceptance needs review"); }
}

/** Internal preparation read. Keep provider/attempt identities out of the
 * existing public recovery projection. Both reads are owner/context scoped and
 * the immutable original fingerprint joins them without catalog regeneration. */
export async function readBuyerMentorshipBootstrapReservation(args: Parameters<typeof readBuyerMentorshipInstallmentReservation>[0]):
  Promise<Awaited<ReturnType<typeof reserveBuyerMentorshipInstallments>> | null> {
  const saved = await readBuyerMentorshipInstallmentReservation(args);
  if (!saved) return null;
  const context = validateExactPaymentContext(args.context, args.contextEvidence);
  const { data, error } = await args.admin.from("buyer_mentorship_installment_reservations_v1")
    .select("id,attempt_id,request_id,buyer_id,product_id,post_id,destination_id,context,fingerprint,status")
    .eq("request_id", args.requestId).eq("buyer_id", args.buyerId).contains("context", context).maybeSingle();
  check(!error && data);
  const row = record(data);
  validateExactPaymentContext(row.context, args.contextEvidence);
  check(row.request_id === saved.requestId && row.buyer_id === args.buyerId && row.product_id === saved.terms.productId &&
    row.post_id === saved.terms.postId && row.status === "reserved" && row.fingerprint === saved.fingerprint &&
    typeof row.destination_id === "string" && /^acct_[A-Za-z0-9]{1,100}$/.test(row.destination_id));
  return Object.freeze({ ...saved, id: uuid(row.id), attemptId: uuid(row.attempt_id), buyerId: args.buyerId,
    productId: saved.terms.productId, postId: uuid(saved.terms.postId), destinationId: row.destination_id });
}

/** Server composition only. buyerId must come from authenticated identity;
 * product and fees from authoritative server reads; context evidence from fresh
 * provider/database observations. No request body may supply those arguments.
 * Stores acceptance only: no provider mutation, checkout URL or purchase credit.
 * Exact request retries must retain the original server quote; do not silently
 * replace a lost response with a fresh request or changed catalog/fee snapshot.
 */
export async function reserveBuyerMentorshipInstallments(args: QuoteArgs & {
  admin: SupabaseClient; context: unknown; contextEvidence: unknown;
  origin: string | null; requestId: string; acceptance: unknown;
}): Promise<Readonly<{
  id: string; requestId: string; attemptId: string; buyerId: string; productId: string; postId: string;
  destinationId: string; acceptedAt: string; fingerprint: string; terms: AcceptedTerms;
  status: "reserved"; providerOperationsAllowed: false;
}>> {
  try {
    const context = validateExactPaymentContext(args.context, args.contextEvidence);
    check(args.origin === context.siteOrigin);
    const requestId = uuid(args.requestId), buyerId = uuid(args.buyerId), productId = uuid(args.product.id), postId = uuid(args.postId);
    uuid(args.product.creator_id);
    const quote = mentorshipInstallmentQuote(args);
    const accepted = record(args.acceptance);
    check(Object.keys(accepted).length === 3 && Object.keys(accepted).every(key => ["accepted", "version", "fingerprint"].includes(key)) &&
      accepted.accepted === true && accepted.version === quote.terms.version && accepted.fingerprint === quote.fingerprint);
    const termsText = JSON.stringify(quote.terms);
    const { data, error } = await args.admin.rpc("reserve_buyer_mentorship_installments_v1", {
      p_request_id: requestId, p_buyer_id: buyerId, p_product_id: productId, p_post_id: postId,
      p_context: context, p_terms_text: termsText, p_fingerprint: quote.fingerprint,
    }).single();
    check(!error);
    const row = record(data);
    const reservationId = uuid(row.id), attemptId = uuid(row.attempt_id);
    validateExactPaymentContext(row.context, args.contextEvidence);
    check(row.request_id === requestId && row.buyer_id === buyerId && row.product_id === productId && row.post_id === postId &&
      row.creator_id === quote.terms.creatorId && row.fingerprint === quote.fingerprint && row.status === "reserved" &&
      operationHash(row.terms) === operationHash(quote.terms) && typeof row.destination_id === "string" &&
      /^acct_[A-Za-z0-9]{1,100}$/.test(row.destination_id) && typeof row.accepted_at === "string" &&
      Number.isFinite(Date.parse(row.accepted_at)) && Date.parse(row.accepted_at) > 0);
    return Object.freeze({ id: reservationId, requestId, attemptId, buyerId, productId, postId,
      destinationId: row.destination_id, acceptedAt: row.accepted_at, fingerprint: quote.fingerprint,
      terms: JSON.parse(termsText) as AcceptedTerms, status: "reserved", providerOperationsAllowed: false });
  } catch {
    // A lost/invalid reply may follow a committed reservation. Preserve its
    // request ID for reconciliation; never leak provider/database error text.
    throw Error("Installment acceptance needs review");
  }
}
