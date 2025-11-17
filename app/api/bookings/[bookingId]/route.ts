import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";

const SUPABASE_URL: string =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  (process.env as any).NEXT_PUBLIC_SUPABASE_UR;
const SERVICE_ROLE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET || "super-secret-jwt-token-with-at-least-32-characters-long";

if (!SUPABASE_URL) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) environment variable.");
}
if (!SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const { bookingId } = await params;
  if (!bookingId) {
    return NextResponse.json({ error: "Missing booking id" }, { status: 400 });
  }

  const headerToken = extractBearerToken(req.headers.get("authorization"));
  const cookieStore = await cookies();
  const accessToken = headerToken || extractAccessToken(cookieStore);

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = decodeUserId(accessToken);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: booking, error: bookingError } = await admin
      .from("bookings")
      .select("id, creator_id")
      .eq("id", bookingId)
      .maybeSingle<{ id: string; creator_id: string }>();

    if (bookingError) throw bookingError;
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    if (booking.creator_id !== userId) {
      return NextResponse.json(
        { error: "Forbidden", details: "You do not own this booking." },
        { status: 403 }
      );
    }

    const { error: paymentDeleteError } = await admin
      .from("booking_payments")
      .delete()
      .eq("booking_id", bookingId);

    if (
      paymentDeleteError &&
      !/booking_payments.*does not exist/i.test(paymentDeleteError.message || "")
    ) {
      throw paymentDeleteError;
    }

    const { error: bookingDeleteError } = await admin
      .from("bookings")
      .delete()
      .eq("id", bookingId);

    if (bookingDeleteError) {
      throw bookingDeleteError;
    }

    console.log("[booking-delete] removed", { bookingId, creatorId: userId });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[booking-delete] error:", {
      message: error?.message || error,
      details: error?.details,
      hint: error?.hint,
      code: error?.code,
    });
    return NextResponse.json(
      {
        error: "Failed to delete booking",
        details: error?.message || "Unknown error",
        supabase: {
          details: error?.details ?? null,
          hint: error?.hint ?? null,
          code: error?.code ?? null,
        },
      },
      { status: 500 }
    );
  }
}

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
    console.warn("[booking-delete] extractAccessToken failed:", err);
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
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    return typeof decoded?.sub === "string" ? decoded.sub : null;
  } catch (err) {
    console.warn("[booking-delete] decodeUserId failed:", err);
    return null;
  }
}

