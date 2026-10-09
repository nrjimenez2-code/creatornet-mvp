import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { isSafeId } from "@/lib/ids";
import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";
import { purchasePoliciesActive } from "@/lib/purchasePolicies";
import type { ConsentProduct } from "@/lib/purchaseConsent";
import { mentorshipInstallmentOffersReady } from "@/lib/mentorshipInstallmentOptions";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { getProcessingFeeSchedule, getSubscriptionProcessingFeeSchedule } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
type Product = ConsentProduct & { installment_options: number[]; active: boolean | null };
export async function GET(req: NextRequest) {
  if (!mentorshipInstallmentOffersReady() || !purchasePoliciesActive(process.env) || process.env.CREATOR_PROCESSING_FEE_ENABLED !== "true")
    return json({ error: "Buyer-selected installments are not enabled." }, 409);
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: "Sign in to review your payment choices." }, 401);
    const params = req.nextUrl.searchParams;
    if ([...params.keys()].some(key => !["product_id", "post_id", "payment_count"].includes(key) || params.getAll(key).length !== 1))
      return json({ error: "Choose an offer and its approved payment count." }, 400);
    const productId = params.get("product_id"), count = params.get("payment_count");
    if (!isSafeId(productId) || !count || !/^(?:[2-9]|1[0-9]|2[0-4])$/.test(count))
      return json({ error: "Invalid offer or payment count." }, 400);
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await admin.from("products")
      .select("id,creator_id,title,type,description,price_cents,amount_cents,currency,membership_terms,fixed_service_months,installment_options,active")
      .eq("id", productId).returns<Product[]>().maybeSingle();
    if (result.error || !result.data || result.data.active === false) return json({ error: "Offer not available." }, 404);
    const product = result.data;
    const postId = await resolvePostForProduct(admin, params.get("post_id"), product.id, product.creator_id || "");
    if (postId === INVALID_POST) return json({ error: "This post does not sell that offer." }, 400);
    return json(mentorshipInstallmentQuote({ product, buyerId: user.id, postId, paymentCount: Number(count),
      firstPaymentFees: getProcessingFeeSchedule(process.env), renewalFees: getSubscriptionProcessingFeeSchedule(process.env) }));
  } catch { return json({ error: "This installment offer needs review before payment." }, 409); }
}
