// app/success/page.tsx
"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@/lib/useUser";

type FulfillmentProduct = {
  id: string | null;
  title: string | null;
  type: string | null;
  discord_invite_url: string | null;
  whop_listing_url: string | null;
};

type ConfirmSuccess = {
  ok: true;
  purchase_id?: string;
  status?: "paid" | "pending";
  session_id?: string;
  kind?: "booking";
  booking_redirect_url?: string | null;
  post_id?: string | null;
  creator_id?: string | null;
  product?: FulfillmentProduct | null;
};

type ConfirmResp = ConfirmSuccess | { error: string };

function SuccessPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, loading: authLoading } = useUser();

  // The booking effect must not depend on the session OBJECT: supabase-js
  // emits INITIAL_SESSION with a freshly-parsed (referentially new) session
  // right after subscribe, which would cancel an in-flight booking flow and
  // the run-once ref would then block the retry forever. The effect keys on
  // this boolean instead, and reads the live token through sessionRef so a
  // mid-flow refresh still sends the current token.
  const hasToken = !!session?.access_token;
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Get params directly from URL as fallback
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const sessionId = params.get("session_id") || urlParams?.get("session_id") || "";
  const kindParam = params.get("kind") || urlParams?.get("kind") || "";

  const [status, setStatus] = useState<"checking" | "ok" | "pending" | "error">("checking");
  const [message, setMessage] = useState("Almost there...");
  const triesRef = useRef(0);
  const maxTries = 6; // ~10-12s total with backoff
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [bookingState, setBookingState] = useState<"idle" | "processing" | "ready">("idle");
  const [fulfillment, setFulfillment] = useState<FulfillmentProduct | null>(null);
  const [fulfillmentMessage, setFulfillmentMessage] = useState<string | null>(null);
  const hasSeededRef = useRef(false);
  const hasRunRef = useRef(false);

  async function confirmOnce(): Promise<ConfirmResp> {
    const confirmUrl = typeof window !== "undefined"
      ? `${window.location.origin}/api/confirm-purchase`
      : "/api/confirm-purchase";

    const res = await fetch(confirmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    return data as ConfirmResp;
  }

  // Handle booking flow separately - RUN AS SOON AS AUTH CONTEXT SETTLES
  useEffect(() => {
    // CRITICAL: Read directly from URL - don't wait for React params
    if (typeof window === "undefined") return;

    // Wait for the auth context to settle so the seed step has a real token —
    // "still loading" must never be treated as "signed out".
    if (authLoading) return;

    const urlParams = new URLSearchParams(window.location.search);
    const urlKind = urlParams.get("kind") || "";
    const urlSessionId = urlParams.get("session_id") || "";

    // Only run booking flow if kind=booking
    if (urlKind !== "booking") return;
    if (!urlSessionId) return;
    if (hasRunRef.current) return;

    hasRunRef.current = true;
    let cancelled = false;

    // Set state before starting async flow
    setBookingState("processing");
    setStatus("pending");
    setMessage("Processing your booking...");

    async function runBookingFlow(): Promise<void> {
      // Get session ID from URL directly
      const actualSessionId = urlSessionId;

      if (cancelled) return;

      if (!actualSessionId) {
        setStatus("error");
        setMessage("Missing session ID");
        return;
      }

      try {
        const confirmUrl = typeof window !== "undefined"
          ? `${window.location.origin}/api/confirm-purchase`
          : "/api/confirm-purchase";

        const res = await fetch(confirmUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ session_id: actualSessionId }),
        });

        const data = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) {
          setStatus("error");
          setMessage(`Failed to confirm booking: ${data?.error || "Unknown error"}`);
          return;
        }
        const resp = data as ConfirmResp;

        if (!("kind" in resp) || resp.kind !== "booking") {
          setStatus("error");
          setMessage("Invalid booking session.");
          return;
        }

        const redirect = resp.booking_redirect_url || null;
        const respPostId = resp.post_id ?? null;

        // Step 2: Seed booking BEFORE redirecting - CRITICAL: Must complete before redirect
        if (!respPostId) {
          setStatus("error");
          setMessage("Missing post information. Please contact support with session ID: " + actualSessionId);
          return; // DO NOT REDIRECT if no post_id
        }

        if (hasSeededRef.current) {
          setBookingUrl(redirect);
          setBookingState("ready");
          setStatus("ok");
          setMessage(redirect ? "Booking confirmed! Redirecting..." : "Booking confirmed.");
          if (redirect) {
            setTimeout(() => {
              window.location.assign(redirect);
            }, 500);
          }
          return;
        }

        // CRITICAL: Mark as seeding BEFORE the async call
        hasSeededRef.current = true;
        setStatus("pending");
        setMessage("Creating booking record...");

        try {
          // Token comes from the shared auth context — no network auth call.
          // Read through the ref so a token refreshed mid-flow is picked up.
          const accessToken: string | null = sessionRef.current?.access_token ?? null;

          if (!accessToken) {
            setStatus("error");
            setMessage("Authentication error. Please sign in again.");
            hasSeededRef.current = false; // Reset to allow retry
            hasRunRef.current = false; // Un-latch so the effect re-runs when the token arrives (hasToken flips)
            return;
          }

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          };

          const apiUrl = typeof window !== "undefined"
            ? `${window.location.origin}/api/bookings/seed`
            : "/api/bookings/seed";

          const seedRes = await fetch(apiUrl, {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify({ post_id: respPostId }),
          });

          const seedData = await seedRes.json().catch(() => ({}));

          if (!seedRes.ok) {
            setStatus("error");
            setMessage(`Failed to create booking: ${seedData?.error || "Unknown error"}`);
            hasSeededRef.current = false; // Reset to allow retry
            return; // DO NOT REDIRECT if seed failed
          }

          // Step 3: ONLY redirect after successful seed
          setBookingUrl(redirect);
          setBookingState("ready");
          setStatus("ok");
          setMessage(redirect ? "Booking confirmed! Redirecting..." : "Booking confirmed.");
          if (redirect) {
            setTimeout(() => {
              window.location.assign(redirect);
            }, 2000);
          }
        } catch (seedErr: any) {
          setStatus("error");
          setMessage(`Error creating booking: ${seedErr?.message || "Unknown error"}`);
          hasSeededRef.current = false; // Reset to allow retry
          // DO NOT REDIRECT if seed errored
        }
      } catch (err: any) {
        setStatus("error");
        setMessage(`Error processing booking: ${err?.message || "Unknown error"}`);
      }
    }

    // Run the booking flow
    runBookingFlow().catch((err) => {
      setStatus("error");
      setMessage(`Error: ${err?.message || "Unknown error"}`);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, hasToken]); // Primitives only: object identity of `session` must never cancel an in-flight flow. hasRunRef guards repeats; URL params read directly inside

  // Handle regular purchase flow
  useEffect(() => {
    let cancelled = false;

    // Skip if this is a booking
    if (kindParam === "booking") {
      return;
    }

    async function runPurchaseFlow() {
      if (!sessionId) {
        setStatus("error");
        setMessage("Missing session id.");
        return;
      }

      while (!cancelled && triesRef.current < maxTries) {
        try {
          const resp = await confirmOnce();

          if ("error" in resp) {
            triesRef.current += 1;
            setStatus("pending");
            setMessage(`Finalizing your payment... (${triesRef.current}/${maxTries})`);
          } else {
            const product = resp.product || null;
            const hasFulfillment =
              product &&
              (product.discord_invite_url || product.whop_listing_url) &&
              (product.type === "course" || product.type === "mentorship");

            if (hasFulfillment) {
              setFulfillment(product);
              const friendly =
                product.type === "mentorship"
                  ? "Connect with your mentor"
                  : "Get access to your course";
              setFulfillmentMessage(friendly);
              setStatus("ok");
              setMessage(friendly);
              return;
            }

            if (product?.type === "video" && resp.post_id) {
              setStatus("ok");
              setMessage("Video unlocked! Redirecting to your library...");
              setTimeout(() => router.replace("/library"), 700);
              return;
            }

            if (resp.post_id) {
              setStatus("ok");
              setMessage("Access ready! Redirecting...");
              setTimeout(() => router.replace("/library"), 700);
              return;
            }

            if (resp.purchase_id) {
              setStatus("ok");
              setMessage("Payment confirmed! Redirecting...");
              setTimeout(() => router.replace(`/access/${resp.purchase_id}`), 700);
              return;
            }

            if (resp.status === "paid") {
              setStatus("ok");
              setMessage("Payment confirmed! Redirecting...");
              setTimeout(() => router.replace("/library"), 700);
              return;
            }

            triesRef.current += 1;
            setStatus("pending");
            setMessage(`Waiting for confirmation... (${triesRef.current}/${maxTries})`);
          }
        } catch {
          triesRef.current += 1;
          setStatus("pending");
          setMessage(`Retrying... (${triesRef.current}/${maxTries})`);
        }

        const delay = Math.min(400 * (triesRef.current + 1), 1500);
        await new Promise((r) => setTimeout(r, delay));
      }

      if (!cancelled) {
        setStatus("error");
        setMessage("We couldn't verify your payment yet. It may still post in a minute—check your Library.");
      }
    }

    runPurchaseFlow();
    return () => {
      cancelled = true;
    };
  }, [kindParam, router, sessionId]);

  const showFulfillment = Boolean(fulfillment && fulfillmentMessage);

  return (
    <main className="min-h-svh bg-white text-gray-900 flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        {/* Pulse only while a request is in flight; a pulsing icon next to
            "Heads up" / "Success" reads as "still loading". */}
        <div
          className={`mb-4 text-4xl ${
            status === "checking" || status === "pending" ? "animate-pulse" : ""
          }`}
          aria-hidden="true"
        >
          ✨
        </div>
        <h1 className="text-xl font-semibold mb-2">
          {status === "checking"
            ? "Almost there..."
            : status === "ok"
            ? "Success"
            : status === "pending"
            ? "Finalizing..."
            : "Heads up"}
        </h1>
        <p className="text-sm text-gray-600">{message}</p>

        {showFulfillment && fulfillment && (
          <div className="mt-6 space-y-4">
            {fulfillment.title ? (
              <div className="text-sm text-gray-500">{fulfillment.title}</div>
            ) : null}
            <div className="flex items-center justify-center gap-3 flex-wrap">
              {fulfillment.discord_invite_url ? (
                <a
                  href={fulfillment.discord_invite_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-lg bg-[#5865F2] px-4 py-2 text-sm font-semibold text-white hover:brightness-105"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                    D
                  </span>
                  Join Discord
                </a>
              ) : null}
              {fulfillment.whop_listing_url ? (
                <a
                  href={fulfillment.whop_listing_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                    W
                  </span>
                  Open Whop
                </a>
              ) : null}
            </div>
          </div>
        )}

        {bookingState !== "idle" && (
          <div className="mt-6 flex items-center justify-center">
            <button
              onClick={() => {
                if (bookingUrl) window.location.assign(bookingUrl);
              }}
              className="px-4 py-2 text-sm rounded-lg bg-black text-white disabled:opacity-60"
              disabled={bookingState !== "ready" || !bookingUrl}
            >
              {bookingState === "ready" ? "Book" : "Processing your payment..."}
            </button>
          </div>
        )}

        {!showFulfillment && status === "error" && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={() => router.replace("/library")}
              className="px-4 py-2 text-sm rounded-lg bg-black text-white"
            >
              Go to Library
            </button>
            <button
              onClick={() => router.replace("/dashboard")}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300"
            >
              Go to Dashboard
            </button>
          </div>
        )}

        <p className="mt-8 text-xs text-gray-500">
          Questions?{" "}
          <a href="mailto:support@creatornet.net" className="underline hover:text-gray-700">
            support@creatornet.net
          </a>
          {" · "}
          <a href="/legal/refunds" className="underline hover:text-gray-700">
            Refund policy
          </a>
        </p>
      </div>
    </main>
  );
}

export default function SuccessPageWrapper() {
  return (
    <Suspense fallback={<main className="min-h-svh bg-white flex items-center justify-center text-sm text-gray-500">Loading…</main>}>
      <SuccessPage />
    </Suspense>
  );
}
