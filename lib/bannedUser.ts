// lib/bannedUser.ts — making a ban actually do something.
//
// /api/admin/ban sets profiles.banned_at and writes an admin_actions row, and
// that was the entire effect. Verified in production: zero RLS policies
// reference banned_at, zero database functions reference it, and the only code
// that read it rendered the "banned" label in the admin UI. A banned user kept
// their session and could still post, comment, review and follow. It was the
// founder's only lever against an abusive user, and pulling it changed nothing.
//
// TWO DELIBERATE LIMITS ON THIS FIX
//
// 1. It FAILS OPEN. If the lookup errors, the user is treated as not banned.
//    The alternative — failing closed — turns any transient database problem
//    into "nobody on the site can post", which is far worse than an abusive
//    user getting a few more minutes. Bans are rare; outages affect everyone.
//
// 2. It is applied EXPLICITLY at the routes that create content, not inside
//    getAuthenticatedUser(). Putting it in the shared auth helper would also
//    put it in front of /api/checkout and /api/confirm-purchase, where a false
//    positive means a paying buyer is refused their file. The audit's own note
//    on this warned that the shared-helper version "touches nearly every
//    authenticated route and can log everyone out if it is wrong".
//
// NOT covered here, on purpose: reading. A banned user can still browse. Their
// own posts disappearing from the feed is the other half of this change and
// lives in get_feed_v3 — see docs/017 stage E.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Is this user banned?
 *
 * @param supabase any client that can read the user's own profiles row — the
 *   request-scoped client is enough, since the profiles SELECT policy allows
 *   `auth.uid() = id`.
 * @returns true only when banned_at is definitely set. Any doubt returns false.
 */
export async function isUserBanned(
  supabase: SupabaseClient,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;

  const { data, error } = await supabase
    .from("profiles")
    .select("banned_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    // Fail open, loudly. See the note above: a lookup failure must never become
    // a site-wide write outage.
    console.warn("[banned] could not check ban status for", userId, "-- allowing:", error.message);
    return false;
  }

  return Boolean((data as { banned_at?: string | null } | null)?.banned_at);
}

/** The response a banned user gets when they try to create something. */
export function bannedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "Your account has been suspended. Contact support if you think this is a mistake.",
      code: "ACCOUNT_BANNED",
    },
    { status: 403 }
  );
}
