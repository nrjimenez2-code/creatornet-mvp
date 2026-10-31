import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/admin/server";
import { getTrustedSession } from "@/lib/trustedSession";
import { trustedMfaStatus } from "@/lib/adminMfa";
import { loadReleaseSettings, verifiedIdentity } from "@/lib/release/server";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
/** Bootstrap only: never returns admin data or factor secrets and requires no
 * AAL2, so the saved owner can enroll before administrator controls are gated. */
export async function GET(req: NextRequest) {
  try {
    const session = await getTrustedSession(req);
    if (!session || !verifiedIdentity(session.user)) return reply({ error: "Sign in to manage account security." }, 401);
    const profile = await adminClient().from("profiles").select("role,banned_at").eq("id", session.user.id).maybeSingle();
    const settings = await loadReleaseSettings();
    if (profile.error || !profile.data || profile.data.banned_at || (profile.data.role !== "admin" && settings?.owner_id !== session.user.id)) return reply({ error: "Administrator account required." }, 403);
    return reply({ userId: session.user.id, ...trustedMfaStatus(session) });
  } catch { return reply({ error: "Account security is temporarily unavailable. Try again." }, 503); }
}
