"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@/lib/useUser";

function Connect() {
  const provider = useSearchParams().get("provider");
  const { userId, session, loading } = useUser();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loading || started.current) return;
    if (!userId) { setError("Sign in to CreatorNet in your original window, then try connecting again."); return; }
    if (provider !== "calcom" && provider !== "calendly" && provider !== "google") { setError("Choose a supported booking provider."); return; }
    started.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/scheduling/oauth/start", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
          body: JSON.stringify({ provider }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not begin connection");
        const url = new URL(result.url);
        if (url.origin !== (provider === "google" ? "https://accounts.google.com" : provider === "calcom" ? "https://app.cal.com" : "https://auth.calendly.com")) throw new Error("Invalid provider destination");
        window.opener = null;
        window.location.replace(url.toString());
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not begin connection"); }
    })();
  }, [loading, userId, session?.access_token, provider]);
  return <main className="mx-auto max-w-lg space-y-4 p-8 text-white">
    <h1 className="text-xl font-semibold">Connect your booking provider</h1>
    {error ? <p role="alert">{error}</p> : <p role="status">Opening secure authorization…</p>}
    <p>Your post draft is waiting in the original CreatorNet window.</p>
    <button type="button" className="rounded bg-white px-4 py-2 text-black" onClick={() => window.close()}>Return to CreatorNet</button>
  </main>;
}
export default function ConnectPage() { return <Suspense fallback={<p>Opening connection…</p>}><Connect /></Suspense>; }
