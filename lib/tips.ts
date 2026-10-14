import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { calculateCreatorFees, creatorFeeMetadata, type CreatorFeeBreakdown } from "@/lib/money";
import { getStripe } from "@/lib/stripeClient";

export const TIP_MIN_CENTS = 500;
export const TIP_MAX_CENTS = 50_000;
export const TIP_CURRENCY = "usd";
export const TIP_METADATA_VERSION = "video-tip-v1";

export type TipRow = {
  id: string;
  tipper_id: string;
  creator_id: string;
  post_id: string;
  client_request_key: string;
  terms_fingerprint: string;
  gross_amount_cents: number;
  platform_fee_cents: number;
  processing_fee_cents: number;
  total_creator_deduction_cents: number;
  creator_net_cents: number;
  processing_fee_enabled: boolean;
  processing_fee_basis_points: number;
  processing_fee_fixed_cents: number;
  fee_schedule_version: string;
  currency: string;
  status: "creating" | "open" | "processing" | "paid" | "failed" | "canceled";
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_destination_account_id: string;
  stripe_checkout_params?: Stripe.Checkout.SessionCreateParams | null;
  refunded_amount_cents: number;
};

export const TIP_COLUMNS = [
  "id", "tipper_id", "creator_id", "post_id", "client_request_key", "terms_fingerprint",
  "gross_amount_cents", "platform_fee_cents", "processing_fee_cents",
  "total_creator_deduction_cents", "creator_net_cents", "processing_fee_basis_points",
  "processing_fee_fixed_cents", "processing_fee_enabled", "fee_schedule_version", "currency", "status",
  "stripe_checkout_session_id", "stripe_payment_intent_id", "stripe_charge_id",
  "stripe_destination_account_id", "refunded_amount_cents",
].join(",");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validTipAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= TIP_MIN_CENTS && Number(value) <= TIP_MAX_CENTS;
}

export function validTipRequestKey(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function tippingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREATOR_TIPPING_ENABLED === "true";
}

export type TipEligibility = {
  postId: string;
  creatorId: string;
  creatorUsername: string;
  destinationAccountId: string;
};

export class TipAdmissionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TipAdmissionError";
  }
}

export async function requireTipEligibility(
  admin: SupabaseClient,
  user: User,
  postId: string,
): Promise<TipEligibility> {
  if (!UUID_RE.test(postId)) throw new TipAdmissionError(400, "INVALID_POST", "Invalid video.");
  const { data: post, error } = await admin.from("posts").select(
    "id,video_url,creator_id,product_id,offering_id,premium_path,price_cents,allow_booking,booking_url,cta_type,fulfillment_url,display_price,booking_url_override,tips_enabled,active,hidden_at,removed_at",
  ).eq("id", postId).maybeSingle();
  if (error) throw new Error(`Tip post lookup failed: ${error.message}`);
  if (!post || post.active === false || post.hidden_at || post.removed_at) {
    throw new TipAdmissionError(404, "POST_UNAVAILABLE", "This video is unavailable.");
  }
  if (!post.tips_enabled) throw new TipAdmissionError(409, "TIPPING_DISABLED", "Tips are not enabled for this video.");
  if (typeof post.video_url !== "string" || !post.video_url.trim()) {
    throw new TipAdmissionError(409, "NOT_VIDEO", "Only videos can receive tips.");
  }
  const creatorId = String(post.creator_id || "");
  if (!creatorId) throw new TipAdmissionError(409, "CREATOR_UNAVAILABLE", "This creator cannot receive tips.");
  if (creatorId === user.id) throw new TipAdmissionError(403, "SELF_TIP", "You cannot tip yourself.");
  const monetized = Boolean(
    post.product_id || post.offering_id || post.premium_path || Number(post.price_cents || 0) !== 0 ||
    post.allow_booking || post.booking_url || (post.cta_type && post.cta_type !== "none") ||
    post.fulfillment_url || post.display_price || post.booking_url_override
  );
  if (monetized) throw new TipAdmissionError(409, "NOT_TIP_ONLY", "This video is not eligible for tips.");

  const { data: creator, error: creatorError } = await admin.from("profiles")
    .select("id,username,banned_at,stripe_account_id,stripe_onboarding_complete")
    .eq("id", creatorId).maybeSingle();
  if (creatorError) throw new Error(`Tip creator lookup failed: ${creatorError.message}`);
  if (!creator || creator.banned_at) throw new TipAdmissionError(403, "CREATOR_UNAVAILABLE", "This creator cannot receive tips.");
  const destination = typeof creator.stripe_account_id === "string" ? creator.stripe_account_id : "";
  if (!creator.stripe_onboarding_complete || !/^acct_[A-Za-z0-9]+$/.test(destination)) {
    throw new TipAdmissionError(409, "CONNECT_UNAVAILABLE", "This creator is not accepting tips right now.");
  }
  const account = await getStripe().accounts.retrieve(destination);
  if (!account.charges_enabled || !account.payouts_enabled) {
    await admin.from("profiles").update({
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      stripe_onboarding_complete: false,
    }).eq("id", creatorId);
    throw new TipAdmissionError(409, "CONNECT_UNAVAILABLE", "This creator is not accepting tips right now.");
  }
  return {
    postId: String(post.id), creatorId,
    creatorUsername: String(creator.username || "creator"), destinationAccountId: destination,
  };
}

export function tipTermsFingerprint(input: {
  tipperId: string; postId: string; creatorId: string; destinationAccountId: string;
  fees: CreatorFeeBreakdown;
}): string {
  const f = input.fees;
  return createHash("sha256").update([
    TIP_METADATA_VERSION, input.tipperId, input.postId, input.creatorId,
    input.destinationAccountId, TIP_CURRENCY, f.grossAmountCents, f.platformFeeCents,
    f.processingFeeCents, f.totalCreatorDeductionCents, f.creatorNetCents, f.processingFeeEnabled,
    f.processingFeeBasisPoints, f.processingFeeFixedCents, f.feeScheduleVersion,
  ].join("\n")).digest("hex");
}

export function tipMetadata(tip: TipRow): Record<string, string> {
  return {
    creatornet_payment_version: TIP_METADATA_VERSION,
    payment_kind: "video_tip",
    tip_id: tip.id,
    post_id: tip.post_id,
    creator_id: tip.creator_id,
    tipper_id: tip.tipper_id,
    checkout_terms_fingerprint: tip.terms_fingerprint,
    ...creatorFeeMetadata({
      grossAmountCents: Number(tip.gross_amount_cents),
      platformFeeCents: Number(tip.platform_fee_cents),
      processingFeeCents: Number(tip.processing_fee_cents),
      totalCreatorDeductionCents: Number(tip.total_creator_deduction_cents),
      creatorNetCents: Number(tip.creator_net_cents),
      processingFeeEnabled: tip.processing_fee_enabled,
      processingFeeBasisPoints: Number(tip.processing_fee_basis_points),
      processingFeeFixedCents: Number(tip.processing_fee_fixed_cents),
      feeScheduleVersion: tip.fee_schedule_version,
    }),
  };
}

export function newTipInsert(args: {
  id: string; user: User; requestKey: string; eligibility: TipEligibility; amountCents: number;
}) {
  const fees = calculateCreatorFees(args.amountCents);
  const terms = tipTermsFingerprint({
    tipperId: args.user.id, postId: args.eligibility.postId,
    creatorId: args.eligibility.creatorId, destinationAccountId: args.eligibility.destinationAccountId, fees,
  });
  return {
    id: args.id, tipper_id: args.user.id, creator_id: args.eligibility.creatorId,
    post_id: args.eligibility.postId, client_request_key: args.requestKey,
    terms_fingerprint: terms, gross_amount_cents: fees.grossAmountCents,
    platform_fee_cents: fees.platformFeeCents, processing_fee_cents: fees.processingFeeCents,
    total_creator_deduction_cents: fees.totalCreatorDeductionCents,
    creator_net_cents: fees.creatorNetCents,
    processing_fee_enabled: fees.processingFeeEnabled,
    processing_fee_basis_points: fees.processingFeeBasisPoints,
    processing_fee_fixed_cents: fees.processingFeeFixedCents,
    fee_schedule_version: fees.feeScheduleVersion, currency: TIP_CURRENCY,
    status: "creating", stripe_destination_account_id: args.eligibility.destinationAccountId,
  };
}

export function isTipStripeObject(object: { metadata?: Stripe.Metadata | null }): boolean {
  return object.metadata?.payment_kind === "video_tip" &&
    object.metadata?.creatornet_payment_version === TIP_METADATA_VERSION &&
    typeof object.metadata?.tip_id === "string";
}
