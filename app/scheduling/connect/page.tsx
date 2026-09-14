"use client";
import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@/lib/useUser";
import { BOOKING_PROVIDER_NAMES } from "@/lib/schedulingConnectionTypes";

function Connect() {
  const provider = useSearchParams().get("provider");
  const { userId, session, loading } = useUser();
  const started = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = provider === "calcom" || provider === "calendly" || provider === "google";
  async function connect() {
    if (loading || started.current) return;
    if (!userId) { setError("Sign in to CreatorNet in your original window, then try connecting again."); return; }
    if (provider !== "calcom" && provider !== "calendly" && provider !== "google") { setError("Choose a supported booking provider."); return; }
    started.current = true;
    setOpening(true);
    setError(null);
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
      } catch (cause) {
        started.current = false;
        setOpening(false);
        setError(cause instanceof Error ? cause.message : "Could not begin connection");
      }
  }
  return <main className="mx-auto max-w-lg space-y-4 p-8 text-white">
    <h1 className="text-xl font-semibold">Connect your booking provider</h1>
    {supported ? <>
      <h2 className="font-semibold">How CreatorNet uses your connection</h2>
      {provider === "google" ? <p>We access your Google account email, calendar list, availability and events to check conflicts and manage calls. You choose the calendars and booking hours. We create, reschedule and cancel CreatorNet booking events; Google may send invitations and updates to attendees. The permission includes events on calendars you own, including events unrelated to CreatorNet.</p>
        : <p>We access your {BOOKING_PROVIDER_NAMES[provider]} account identity, event types and scheduled-event information, and set up notifications to keep CreatorNet bookings current.</p>}
      <p>We store encrypted authorization tokens, scheduling settings and booking records. Our hosting and database providers process this data to run scheduling; participants receive the information needed for their call.</p>
      <p>Verified bookings and later purchases are linked to the video that led to them. These milestones support creator reporting and feed recommendations. Calendar availability and unrelated event content are not used to rank videos.</p>
      <p>You can disconnect in Bookings. A completed disconnect removes stored authorization tokens. It does not cancel appointments or delete historical booking and purchase records.</p>
      <p>Read our <a className="underline" href="/legal/privacy#connected-calendars" target="_blank" rel="noopener noreferrer">connected calendar privacy disclosure</a>, including retention and deletion choices. Connecting is optional.</p>
      <button type="button" disabled={loading || opening} className="rounded bg-white px-4 py-2 text-black disabled:opacity-50" onClick={() => void connect()}>Continue to {BOOKING_PROVIDER_NAMES[provider]}</button>
    </> : <p role="alert">Choose a supported booking provider.</p>}
    {error && <p role="alert">{error}</p>}
    {(loading || opening) && <p role="status">{opening ? "Opening secure authorization…" : "Checking sign-in…"}</p>}
    <p>Your post draft is waiting in the original CreatorNet window.</p>
    <button type="button" className="rounded bg-white px-4 py-2 text-black" onClick={() => window.close()}>Return to CreatorNet</button>
  </main>;
}
export default function ConnectPage() { return <Suspense fallback={<p>Opening connection…</p>}><Connect /></Suspense>; }
