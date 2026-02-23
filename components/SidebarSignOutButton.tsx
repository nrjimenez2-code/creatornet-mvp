"use client";

import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { createBrowserClient } from "@/lib/supabaseBrowser";

const supabase = createBrowserClient();

export default function SidebarSignOutButton() {
  const [signingOut, setSigningOut] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setDialogOpen(false);
    try {
      await supabase.auth.signOut();
      window.location.href = "/auth";
    } catch (err) {
      console.error("Failed to sign out:", err);
      setSigningOut(false);
    }
  }, [signingOut]);

  const dialog =
    dialogOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            aria-modal="true"
            role="dialog"
            aria-labelledby="signout-dialog-title"
            onClick={() => setDialogOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setDialogOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#1A1F22] shadow-xl shadow-black/50 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="signout-dialog-title" className="text-lg font-semibold text-white mb-2">
                Sign out
              </h2>
              <p className="text-white/80 text-sm mb-6">
                Are you sure you want to sign out?
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white/80 bg-white/10 border border-white/15 hover:bg-white/15 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[#4A35C7] hover:brightness-95 disabled:opacity-50 transition"
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        disabled={signingOut}
        className="w-full rounded-xl border-0 lg:border lg:border-white/15 bg-transparent lg:bg-white/5 px-2 lg:px-4 py-2 text-sm font-semibold text-white/70 lg:text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-50 flex items-center justify-center"
        title="Sign out"
      >
        <img src="/sign_out.png" alt="Sign out" className="h-6 w-6 lg:hidden -translate-y-6.5" />
        <span className="hidden lg:inline">{signingOut ? "Signing out…" : "Sign out"}</span>
      </button>
      {dialog}
    </>
  );
}


