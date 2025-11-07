// app/api/book/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase credentials.
 * NOTE: SUPABASE_SERVICE_ROLE_KEY must NEVER be exposed client-side.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

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

    /** 1) If a specific post is provided, prefer its explicit booking_url */
    if (postId) {
      const { data: post, error: postErr } = await admin
        .from("posts")
        .select("booking_url")
        .eq("id", postId)
        .single();

      if (!postErr && isHttpUrl(post?.booking_url)) {
        return NextResponse.redirect(post.booking_url, 302);
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
        return NextResponse.redirect(record.booking_url, 302);
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
        return NextResponse.redirect(url, 302);
      }
    }

    /** 4) Final fallback: profiles.booking_url if allowed */
    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("booking_url, allow_booking")
      .eq("id", creatorId)
      .single();

    if (!profErr && prof?.allow_booking && isHttpUrl(prof?.booking_url)) {
      return NextResponse.redirect(prof.booking_url, 302);
    }

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
