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
      className="w-full rounded-xl border-0 lg:border lg:border-white/15 bg-transparent lg:bg-white/5 px-2 lg:px-4 py-2 text-sm font-semibold text-white/70 lg:text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-50 flex items-center justify-center"
      title="Sign out"
    >
      {/* Icon only on small screens */}
      <img src="/sign_out.png" alt="Sign out" className="h-6 w-6 lg:hidden -translate-y-6.5" />
      {/* Text on large screens */}
      <span className="hidden lg:inline">{signingOut ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}


