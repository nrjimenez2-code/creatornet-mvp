import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: NextRequest) {
  try {
    const { post_id } = await req.json();
    if (!post_id) {
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const bearerHeader = req.headers.get("authorization");
    const accessToken = extractBearerToken(bearerHeader) || extractAccessToken(cookieStore);
    if (!accessToken) {
      console.error("[bookings-seed] not seeded not seeded seeded", "missing access token");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = decodeUserId(accessToken);
    if (!userId) {
      console.error("[bookings-seed] not seeded not seeded seeded", "failed to decode user id");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: post, error: postErr } = await admin
      .from("posts")
      .select("id, creator_id")
      .eq("id", post_id)
      .single();

    if (postErr || !post || !post.creator_id) {
      console.error("[bookings-seed] not seeded not seeded seeded", "post missing", postErr?.message || postErr);
      return NextResponse.json({ error: "post_not_found" }, { status: 404 });
    }

    const { data: existing } = await admin
      .from("bookings")
      .select("id")
      .eq("post_id", post.id)
      .eq("buyer_id", userId)
      .maybeSingle();

    if (existing?.id) {
      console.log("[bookings-seed] seed seed seed", { booking_id: existing.id, reason: "already_exists" });
      return NextResponse.json({ ok: true, booking_id: existing.id });
    }

    const { data, error: insertError } = await admin
      .from("bookings")
      .insert({
        post_id: post.id,
        creator_id: post.creator_id,
        buyer_id: userId,
        status: "booked",
      })
      .select("id")
      .maybeSingle();

    if (insertError) {
      console.error("[bookings-seed] not seeded not seeded seeded", insertError.message);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    console.log("[bookings-seed] seed seed seed", { booking_id: data?.id ?? null, reason: "inserted" });
    return NextResponse.json({ ok: true, booking_id: data?.id ?? null });
  } catch (err: any) {
    console.error("[bookings-seed] not seeded not seeded seeded", err?.message || err);
    return NextResponse.json({ error: err?.message || "Failed to seed booking" }, { status: 500 });
  }
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/Bearer\s+(.+)/i);
  return match ? match[1].trim() : null;
}

function extractAccessToken(cookieStore: CookieStore): string | null {
  try {
    const projectRef = new URL(SUPABASE_URL).host.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookie = cookieStore.get(cookieName);
    if (!cookie?.value) return null;

    let raw = cookie.value;
    if (raw.startsWith("base64-")) {
      raw = raw.slice("base64-".length);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        const normalized = normalizeBase64(raw);
        const decoded = Buffer.from(normalized, "base64").toString("utf8");
        parsed = JSON.parse(decoded);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) return null;
    if (Array.isArray(parsed)) {
      const [access_token] = parsed;
      return typeof access_token === "string" ? access_token : null;
    }
    if (typeof parsed === "object") {
      return typeof parsed?.access_token === "string" ? parsed.access_token : null;
    }
    return null;
  } catch (err) {
    console.warn("[bookings-seed] extractAccessToken failed:", err);
    return null;
  }
}

function normalizeBase64(input: string): string {
  const replaced = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = replaced.length % 4;
  if (padding === 0) return replaced;
  return replaced.padEnd(replaced.length + (4 - padding), "=");
}

function decodeUserId(token: string): string | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const normalized = normalizeBase64(payload);
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed?.sub === "string" ? parsed.sub : null;
  } catch (err) {
    console.warn("[bookings-seed] decodeUserId failed:", err);
    return null;
  }
}
