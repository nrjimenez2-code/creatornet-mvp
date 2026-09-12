import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PURCHASE_POLICY, PURCHASE_POLICY_VERSION, purchasePoliciesActive } from "./purchasePolicies";
import { FIXED_SERVICE_VERSION, fixedServiceDescription, readFixedServiceMonths } from "./fixedServiceTerms";

export type ConsentProduct = {
  id: string; creator_id?: string | null; title?: string | null; type?: string | null;
  description?: string | null; amount_cents?: number | null; price_cents?: number | null;
  currency?: string | null; membership_terms?: unknown; fixed_service_months?: number | null;
};
export type ProductPurchaseTerms = ReturnType<typeof productPurchaseTerms>;
export function productPurchaseTerms(product: ConsentProduct, buyerId: string, postId: string | null) {
  const cents = Number(product.amount_cents ?? product.price_cents);
  if (!product.id || !product.creator_id || !buyerId || !Number.isSafeInteger(cents) || cents < 50 || cents > 99999999 ||
      (product.currency || "usd").toLowerCase() !== "usd" || product.membership_terms != null ||
      (product.fixed_service_months != null && !["video", "course", "mentorship"].includes(product.type || ""))) {
    throw Error("This offer needs its supported purchase agreement before checkout");
  }
  const terms = {
    version: PURCHASE_POLICY_VERSION,
    kind: product.type === "call" ? "paid_call" as const : "one_time" as const,
    buyerId, creatorId: product.creator_id, productId: product.id, postId,
    title: String(product.title || "Purchase"), description: String(product.description || ""),
    amountCents: cents, currency: "usd" as const,
    billing: "One payment for the listed offer. No monthly subscription or automatic renewal is authorized by this checkout.",
    ...(product.fixed_service_months != null ? {
      serviceVersion: FIXED_SERVICE_VERSION,
      serviceMonths: readFixedServiceMonths(product.fixed_service_months),
      serviceDescription: fixedServiceDescription(product.fixed_service_months),
    } : {}),
    policy: PURCHASE_POLICY,
  };
  return { terms, fingerprint: createHash("sha256").update(JSON.stringify(terms)).digest("hex") };
}

export async function requireProductConsent(args: {
  admin: SupabaseClient; product: ConsentProduct; buyerId: string; postId: string | null;
  input: unknown; site: string; origin: string | null; env: Record<string, string | undefined>;
}): Promise<{ consentId: string | null; response?: Response }> {
  if (args.product.fixed_service_months != null &&
      (!purchasePoliciesActive(args.env) || args.env.CREATOR_FIXED_SERVICE_SCHEMA_READY !== "true" ||
       args.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY !== "true")) {
    throw Error("This fixed-service purchase agreement is not active");
  }
  if (!purchasePoliciesActive(args.env)) {
    if (args.input != null) throw Error("This purchase agreement is not active");
    return { consentId: null };
  }
  const quote = productPurchaseTerms(args.product, args.buyerId, args.postId);
  if (args.input == null) {
    const url = new URL("/purchase/review", args.site);
    url.searchParams.set("product_id", args.product.id);
    if (args.postId) url.searchParams.set("post_id", args.postId);
    return { consentId: null, response: Response.json({ url: url.toString(), requires_consent: true }, { headers: { "Cache-Control": "private, no-store" } }) };
  }
  const input = args.input as Record<string, unknown>;
  if (!args.origin || new URL(args.site).origin !== args.origin || typeof input !== "object" || Array.isArray(input) ||
      input.accepted !== true || input.version !== PURCHASE_POLICY_VERSION || input.fingerprint !== quote.fingerprint ||
      Object.keys(input).some(key => !["accepted", "version", "fingerprint"].includes(key))) {
    return { consentId: null, response: Response.json({ error: "Review and accept the current purchase terms before payment." }, { status: 409 }) };
  }
  const result = await args.admin.rpc("record_product_purchase_consent_v1", {
    p_buyer_id: args.buyerId, p_creator_id: args.product.creator_id, p_product_id: args.product.id,
    p_post_id: args.postId, p_terms: quote.terms, p_fingerprint: quote.fingerprint,
  });
  if (result.error || typeof result.data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.data)) {
    throw Error("Purchase acceptance could not be recorded safely");
  }
  return { consentId: result.data };
}
