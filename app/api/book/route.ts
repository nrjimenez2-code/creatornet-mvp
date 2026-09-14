// app/api/book/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import { attributedBookingUrl } from "@/lib/discoverBookings";

/**
 * Server-only Supabase credentials.
 * NOTE: SUPABASE_SERVICE_ROLE_KEY must NEVER be exposed client-side.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Only https, no embedded credentials, or a site-relative path.
// See lib/bookingUrl.ts for the reasoning.
const isHttpUrl = isSafeBookingTarget;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const creatorId = (searchParams.get("creator_id") || "").trim();
    const postId = (searchParams.get("post_id") || "").trim();

    if (!creatorId) {
      return NextResponse.json(
        { error: "creator_id is required" },
        { status: 400 }
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    let attribution:string|null=null;
    const token=searchParams.get('cn_attribution');
    if(process.env.DISCOVER_V4_ENABLED==='true' && token && /^[a-f0-9-]{36}$/.test(token)){
      const {data:a,error}=await admin.from('discover_booking_attribution_v1').select('id')
        .eq('id',token).eq('creator_id',creatorId).eq('post_id',postId).maybeSingle();
      if(!error&&a)attribution=a.id;
    }
    const redirect=(raw:string)=>NextResponse.redirect(attributedBookingUrl(raw,attribution),302);

    /** 1) If a specific post is provided, prefer its explicit booking_url */
    if (postId) {
      const { data: post, error: postErr } = await admin
        .from("posts")
        .select("booking_url")
        .eq("id", postId)
        .single();

      if (!postErr && isHttpUrl(post?.booking_url)) {
        return redirect(post.booking_url);
      }
    }

    /** 2) Try weighted round-robin via RPC (recommended) */
    try {
      const { data: rpcData, error: rpcErr } = await admin.rpc(
        "next_booking_target",
        { p_creator_id: creatorId }
      );

      // RPC defined as RETURNS TABLE(target_id uuid, booking_url text)
      const record = Array.isArray(rpcData) ? rpcData[0] : rpcData;

      if (!rpcErr && record && isHttpUrl(record.booking_url)) {
        return redirect(record.booking_url);
      }
    } catch {
      // If the RPC doesn't exist yet or fails, fall through to the legacy path
    }

    /** 3) Legacy fallback: active rows in `closers` (highest weight) */
    const { data: closerRows, error: closerErr } = await admin
      .from("closers")
      .select("booking_url, weight, active")
      .eq("creator_id", creatorId)
      .eq("active", true)
      .order("weight", { ascending: false })
      .limit(1);

    if (!closerErr && closerRows?.length) {
      const url = closerRows[0]?.booking_url;
      if (isHttpUrl(url)) {
        return redirect(url);
      }
    }

    // There used to be a fourth fallback here reading profiles.booking_url and
    // profiles.allow_booking. Neither column has ever existed: PostgREST
    // rejected the request, `profErr` was always set, and the `!profErr` guard
    // meant the branch could never redirect. It was a wasted round trip on
    // every unrouted booking click that read like a working feature.
    //
    // A creator-level default booking URL has no column to live in, so this is
    // removed rather than repaired; adding one is a schema change, not a fix.
    // The real sources are posts.booking_url (1), next_booking_target (2) and
    // closers.booking_url (3) above — all three verified to exist in
    // production. __tests__/book-route-schema-contract.test.ts pins that.

    return NextResponse.json(
      { error: "No booking destination configured for this creator." },
      { status: 404 }
    );
  } catch (err: any) {
    console.error("[book] error:", err?.message || err);
    return NextResponse.json(
      { error: "Booking router failed" },
      { status: 500 }
    );
  }
}
