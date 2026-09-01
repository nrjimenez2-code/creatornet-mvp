import { NextRequest, NextResponse } from "next/server";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

const SUPABASE_URL: string =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_ROLE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) environment variable.");
}
if (!SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
}

/**
 * DELETE /api/bookings/[bookingId]
 *
 * Identity comes from getAuthenticatedUser, which verifies a Bearer token
 * against Supabase (signature and expiry) and otherwise reads the SSR cookie
 * session. This route used to base64-decode the JWT itself and trust the
 * `sub` claim, which meant any caller could type a creator's id into a fake
 * token and delete their bookings. The closers page already sends a real
 * token, so nothing changes for it.
 */
// Cancelling a booking is rare and destructive; a script should not be able
// to walk it.
const BOOKING_DELETE_RATE = { limit: 20, windowMs: 60_000 };

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  if (!allowRequest(clientKey(req), BOOKING_DELETE_RATE)) {
    return tooManyRequests();
  }

  const { bookingId } = await params;
  if (!bookingId) {
    return NextResponse.json({ error: "Missing booking id" }, { status: 400 });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

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

    const { error: bookingDeleteError } = await admin.from("bookings").delete().eq("id", bookingId);

    if (bookingDeleteError) {
      throw bookingDeleteError;
    }

    console.log("[booking-delete] removed", { bookingId });
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const e = error as { message?: string; code?: string };
    // Full detail stays in the server log; the client gets a generic message.
    console.error("[booking-delete] error:", { message: e?.message, code: e?.code });
    return NextResponse.json(
      { error: "Failed to delete booking", details: "Unknown error" },
      { status: 500 }
    );
  }
}
