"use client";

import { useState } from "react";
import { createBrowserClient } from "@/lib/supabaseBrowser";

const supabase = createBrowserClient();

export default function SidebarSignOutButton() {
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
      window.location.href = "/auth";
    } catch (err) {
      console.error("Failed to sign out:", err);
      setSigningOut(false);
    }
  };

  return (
    <button
      onClick={handleSignOut}
      disabled={signingOut}
      className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}


