// lib/onboardingGate.ts — one definition of "has this user finished signing up?"
//
// This check used to live only in app/page.tsx, and app/onboarding/page.tsx
// carried a comment warning that its own Continue button "must match the gate
// in app/page.tsx" or the two would fight each other. Two copies of a rule that
// must agree is a bug waiting to happen, so there is now one.
//
// A profile is finished when it has a username AND at least one interest. Both
// are collected by /onboarding, and the rest of the app assumes both exist: the
// feed personalises on interests and every card links to a username.

import { createSupabaseServer } from "@/lib/supabaseServer";

/** Where this user needs to be sent, or null if they can stay. */
export type OnboardingRedirect = "/auth" | "/onboarding" | null;

export async function resolveOnboardingRedirect(): Promise<OnboardingRedirect> {
  const supabase = await createSupabaseServer();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return "/auth";

  // RLS on public.profiles allows exactly `auth.uid() = id`, so this reads the
  // caller's own row and nothing else. No service role needed.
  const { data: profile } = await supabase
    .from("profiles")
    .select("username, interests")
    .eq("id", session.user.id)
    .maybeSingle();

  const username = profile?.username;
  const interests = Array.isArray(profile?.interests) ? profile.interests : [];

  if (!username || interests.length === 0) return "/onboarding";

  return null;
}
