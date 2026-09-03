"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/lib/useUser";

// components/landing/SignedInRedirect.tsx — the landing page's safety net for a
// visitor who is signed in on the client but not (yet) on the server.
//
// app/page.tsx decides server-side, from cookies, whether to show the landing
// page. A sign-in that returns to "/" with the session in the URL fragment
// (Supabase's implicit flow does this whenever its redirect lands on a host it
// does not recognise — creatornet.net vs www.creatornet.net) reaches the
// server with no auth cookie at all, so the server renders the logged-out
// marketing page. The browser client then reads the fragment, stores the
// session, and SupabaseAuthSync sets the cookies — but nothing navigates, and
// the signed-in user is left on a page that tells them to sign in. Before the
// landing page existed, "/" bounced to /auth, which carried the fragment along
// and whose own effect took over; this component restores that hand-off.
//
// It goes to /auth, not /dashboard, on purpose: app/auth/page.tsx already owns
// the "onboarding or dashboard?" decision for a signed-in user, and that logic
// is not duplicated here. A visitor with no session is untouched, and `loading`
// is respected so the pre-seed render (and any server render) never redirects.
export default function SignedInRedirect() {
  const router = useRouter();
  const { session, loading } = useUser();

  useEffect(() => {
    if (loading || !session) return;
    router.replace("/auth");
  }, [loading, session, router]);

  return null;
}
