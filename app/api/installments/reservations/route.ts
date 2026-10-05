import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertAgreementId } from "@/lib/installments/agreementStore";
import { exactContextServerConfig } from "@/lib/installments/contextServer";
import { createExactContextRuntime } from "@/lib/installments/contextRuntime";
import { mentorshipInstallmentOffersReady } from "@/lib/mentorshipInstallmentOptions";
import { PURCHASE_POLICY_VERSION, purchasePoliciesActive } from "@/lib/purchasePolicies";
import type { ConsentProduct } from "@/lib/purchaseConsent";
import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";
import { getProcessingFeeSchedule, getSubscriptionProcessingFeeSchedule } from "@/lib/money";
import { readBuyerMentorshipInstallmentReservation, reserveBuyerMentorshipInstallments } from "@/lib/mentorshipInstallmentReservation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => Response.json(body, { status,
  headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" } });
type Product = ConsentProduct & { installment_options: number[]; active: boolean | null };

/** Persists authenticated acceptance only. Complete checkout capabilities must
 * remain off until provider publication, recovery and lifecycle acceptance pass. */
export async function POST(req: NextRequest) {
  if (!mentorshipInstallmentOffersReady() || !purchasePoliciesActive(process.env) ||
    process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY !== "true" ||
    process.env.CREATOR_PROCESSING_FEE_ENABLED !== "true") return json({ error: "Buyer-selected installments are not enabled." }, 409);
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: "Sign in to choose a payment plan." }, 401);
    const config = exactContextServerConfig();
    if (req.headers.get("origin") !== config.approvedContext.siteOrigin) return json({ error: "Invalid request origin." }, 403);
    let body;
    try {
      if (req.nextUrl.searchParams.size) throw Error();
      const text = await req.text(); if (text.length > 8192) throw Error(); body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "acceptance,payment_count,post_id,product_id,request_id") throw Error();
      assertAgreementId(body.request_id); assertAgreementId(body.product_id); assertAgreementId(body.post_id);
      const c = body.acceptance;
      if (!Number.isInteger(body.payment_count) || body.payment_count < 2 || body.payment_count > 24 ||
        !c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join(",") !== "accepted,fingerprint,version" ||
        c.accepted !== true || c.version !== PURCHASE_POLICY_VERSION || typeof c.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(c.fingerprint)) throw Error();
    } catch { return json({ error: "Review the offer and submit its unchanged payment-plan acceptance." }, 400); }
    const observed = await createExactContextRuntime(config).observeContext();
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const scope = { admin, buyerId: user.id, requestId: body.request_id, context: config.approvedContext, contextEvidence: observed.contextEvidence };
    // A committed reply can be lost. Recover before reading a changed catalog or
    // current fees, preserving the originally accepted request and promise.
    const existing = await readBuyerMentorshipInstallmentReservation(scope);
    if (existing) {
      if (existing.terms.productId !== body.product_id || existing.terms.postId !== body.post_id ||
        existing.terms.paymentCount !== body.payment_count || existing.fingerprint !== body.acceptance.fingerprint ||
        existing.terms.version !== body.acceptance.version) return json({ error: "This request already holds a different accepted payment plan." }, 409);
      return json({ ...existing, reused: true });
    }
    const result = await admin.from("products")
      .select("id,creator_id,title,type,description,price_cents,amount_cents,currency,membership_terms,fixed_service_months,installment_options,active")
      .eq("id", body.product_id).returns<Product[]>().maybeSingle();
    if (result.error || !result.data || result.data.active === false) return json({ error: "Offer not available." }, 404);
    const product = result.data;
    if (product.fixed_service_months != null && process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY !== "true")
      return json({ error: "This service agreement is not available." }, 409);
    const postId = await resolvePostForProduct(admin, body.post_id, product.id, product.creator_id || "");
    if (postId === INVALID_POST || postId !== body.post_id) return json({ error: "This post does not sell that offer." }, 400);
    const saved = await reserveBuyerMentorshipInstallments({ ...scope, product, postId, paymentCount: body.payment_count,
      origin: req.headers.get("origin"), acceptance: body.acceptance,
      firstPaymentFees: getProcessingFeeSchedule(process.env), renewalFees: getSubscriptionProcessingFeeSchedule(process.env) });
    return json({ requestId: saved.requestId, status: saved.status, fingerprint: saved.fingerprint, terms: saved.terms,
      acceptedAt: saved.acceptedAt, providerOperationsAllowed: false, reused: false }, 201);
  } catch {
    return json({ error: "Payment-plan acceptance needs review. Keep the original request to recover its saved status." }, 409);
  }
}


/** Read the authenticated buyer's existing acceptance without catalog access.
 * New-offer gates do not prevent recovery; no provider operation is dispatched. */
export async function GET(req:NextRequest) {
  if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY!=="true")
    return json({error:"Saved payment plans are not available."},409);
  try {
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to recover your payment plan."},401);
    const params=req.nextUrl.searchParams,productId=params.get("product_id");
    try {if(params.size!==1 || params.getAll("product_id").length!==1 || !productId)throw Error();assertAgreementId(productId);}
    catch {return json({error:"Invalid saved offer request."},400);}
    const config=exactContextServerConfig(),observed=await createExactContextRuntime(config).observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    let lookup=admin.from("buyer_mentorship_installment_reservations_v1").select("request_id,buyer_id,product_id")
      .eq("buyer_id",user.id).eq("product_id",productId).contains("context",config.approvedContext);
    if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY==="true")lookup=lookup.is("released_at",null);
    const found=await lookup.maybeSingle();
    if(found.error)throw Error();if(!found.data)return json({error:"Saved payment plan not found."},404);
    if(found.data.buyer_id!==user.id || found.data.product_id!==productId)throw Error();
    assertAgreementId(found.data.request_id);
    const saved=await readBuyerMentorshipInstallmentReservation({admin,buyerId:user.id,requestId:found.data.request_id,
      context:config.approvedContext,contextEvidence:observed.contextEvidence});
    if(!saved || saved.terms.productId!==productId || saved.requestId!==found.data.request_id)throw Error();
    return json(saved);
  } catch {return json({error:"Your saved payment plan needs review before payment."},409);}
}
