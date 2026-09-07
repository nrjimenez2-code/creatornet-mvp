import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { bannedResponse, isUserBanned } from "@/lib/bannedUser";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import {
  OPEN_STATUSES,
  VERIFICATION_INSTRUCTIONS,
  generateCode,
  isVerificationPlatform,
  normalizeHandle,
  type VerificationStatus,
} from "@/lib/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Five new codes an hour is plenty for a human who mistyped a handle and far
// below what a script needs to fill the admin queue.
const REQUEST_RATE = { limit: 5, windowMs: 60 * 60_000 };
// Status polls are cheap reads; a minute's worth of clicks is still a lot.
const STATUS_RATE = { limit: 60, windowMs: 60_000 };

const REQUEST_COLUMNS = "id, platform, handle, code, status, reason, created_at, decided_at";

interface RequestRow {
  id: string;
  platform: string;
  handle: string;
  code: string;
  status: VerificationStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** What the creator sees. The code is only shown while it is still usable. */
function publicView(row: RequestRow) {
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    status: row.status,
    reason: row.reason,
    created_at: row.created_at,
    decided_at: row.decided_at,
    code: row.status === "code_issued" ? row.code : null,
  };
}

async function newestRequestFor(db: ReturnType<typeof admin>, creatorId: string) {
  return db
    .from("verification_requests")
    .select(REQUEST_COLUMNS)
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<RequestRow>();
}

/**
 * GET /api/verification — the caller's newest request (or null), plus the
 * instructions so the creator card has one source of truth for its copy.
 */
export async function GET(req: NextRequest) {
  if (!allowRequest(`verification-status:${clientKey(req)}`, STATUS_RATE)) {
    return tooManyRequests();
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await newestRequestFor(admin(), user.id);
  if (error) {
    console.error("[verification] status lookup failed:", error);
    return NextResponse.json({ error: "Could not load your verification status." }, { status: 500 });
  }

  return NextResponse.json({
    request: data ? publicView(data) : null,
    instructions: VERIFICATION_INSTRUCTIONS,
  });
}

/**
 * POST /api/verification {platform, handle} — issue a code. One live request
 * per creator: a pending code or an approved badge answers 409 so the card
 * shows the existing state instead of minting a second code.
 */
export async function POST(req: NextRequest) {
  if (!allowRequest(`verification:${clientKey(req)}`, REQUEST_RATE)) {
    return tooManyRequests("You've requested a few codes already. Wait an hour and try again.", 3600);
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = admin();

  // A suspended account cannot ask to be verified. Fails open on a lookup
  // error — see lib/bannedUser.ts.
  if (await isUserBanned(db, user.id)) {
    return bannedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (!isVerificationPlatform(record.platform)) {
    return NextResponse.json({ error: "Choose Instagram or TikTok." }, { status: 400 });
  }
  const handle = normalizeHandle(record.handle);
  if (!handle) {
    return NextResponse.json(
      { error: "Enter your handle: 1–30 letters, numbers, dots or underscores." },
      { status: 400 }
    );
  }

  const { data: existing, error: lookupError } = await newestRequestFor(db, user.id);
  if (lookupError) {
    console.error("[verification] open-request lookup failed:", lookupError);
    return NextResponse.json({ error: "Could not start verification." }, { status: 500 });
  }
  if (existing && OPEN_STATUSES.includes(existing.status)) {
    const alreadyVerified = existing.status === "approved";
    return NextResponse.json(
      {
        error: alreadyVerified
          ? "Your account is already verified."
          : "You already have a code waiting to be checked.",
        code: alreadyVerified ? "ALREADY_VERIFIED" : "REQUEST_OPEN",
        request: publicView(existing),
      },
      { status: 409 }
    );
  }

  const { data: created, error: insertError } = await db
    .from("verification_requests")
    .insert({
      creator_id: user.id,
      platform: record.platform,
      handle,
      code: generateCode(),
      status: "code_issued",
    })
    .select(REQUEST_COLUMNS)
    .single<RequestRow>();

  if (insertError || !created) {
    console.error("[verification] insert failed:", insertError);
    return NextResponse.json({ error: "Could not start verification." }, { status: 500 });
  }

  return NextResponse.json(
    { request: publicView(created), instructions: VERIFICATION_INSTRUCTIONS },
    { status: 201 }
  );
}
