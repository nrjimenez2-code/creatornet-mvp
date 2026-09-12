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
  kind?: "booking" | "paid_call";
  booking_redirect_url?: string | null;
  post_id?: string | null;
  creator_id?: string | null;
  product?: FulfillmentProduct | null;
};

type ConfirmResp = ConfirmSuccess | { error: string; retryable?: boolean };

function SuccessPage({ sessionId, kindParam }: { sessionId: string; kindParam: string }) {
  const router = useRouter();
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

  const [status, setStatus] = useState<"checking" | "ok" | "pending" | "waiting" | "error">("checking");
  const [message, setMessage] = useState("Almost there...");
  const [checkRun, setCheckRun] = useState(0);
  const maxTries = 12; // Bounded automatic checks, then an explicit Check status action.
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [bookingState, setBookingState] = useState<"idle" | "processing" | "ready">("idle");
  const [fulfillment, setFulfillment] = useState<FulfillmentProduct | null>(null);
  const [fulfillmentMessage, setFulfillmentMessage] = useState<string | null>(null);
  const [confirmedSessionId, setConfirmedSessionId] = useState<string | null>(null);
  const hasSeededRef = useRef(false);
  const hasRunRef = useRef(false);

  async function confirmOnce(signal: AbortSignal): Promise<ConfirmResp> {
    const confirmUrl = typeof window !== "undefined"
      ? `${window.location.origin}/api/confirm-purchase`
      : "/api/confirm-purchase";

    const res = await fetch(confirmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ session_id: sessionId }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as any;
    // A pending response may include a purchase ID. Neither that ID nor a
    // fulfillment URL is proof of access, and HTTP 202 always wins over body.
    if (res.status === 202) return { ok: true, status: "pending" };
    if (!res.ok) return {
      error: typeof data?.error === "string" ? data.error : "Unable to check payment confirmation.",
      retryable: res.status === 429 || res.status >= 500,
    };
    if (res.status !== 200 || data?.ok !== true || !["pending", "paid"].includes(data?.status)) {
      return { error: "Payment confirmation is not available yet.", retryable: true };
    }
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
    let requestController: AbortController | null = null;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    let finishDelay: (() => void) | undefined;

    // Skip if this is a booking
    if (kindParam === "booking") {
      return;
    }

    function redirectTo(path: string) {
      redirectTimer = setTimeout(() => {
        if (!cancelled) router.replace(path);
      }, 700);
    }

    async function runPurchaseFlow() {
      if (!sessionId) {
        setStatus("error");
        setMessage("Missing session id.");
        return;
      }

      for (let attempt = 0; !cancelled && attempt < maxTries; attempt += 1) {
        try {
          requestController = new AbortController();
          const controller = requestController;
          requestTimer = setTimeout(() => controller.abort(), 15_000);
          const resp = await confirmOnce(controller.signal);
          if (cancelled) return;
          if (controller.signal.aborted) throw new Error("Confirmation check timed out");

          if ("error" in resp) {
            if (!resp.retryable) {
              setStatus("error");
              setMessage(resp.error);
              return;
            }
          } else if (resp.status === "paid") {
            setConfirmedSessionId(sessionId);
            if (resp.kind === "paid_call" && resp.booking_redirect_url) {
              setBookingUrl(resp.booking_redirect_url);
              setBookingState("ready");
              setStatus("ok");
              setMessage("Payment confirmed. Choose a time for your call.");
              return;
            }
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
              redirectTo("/library");
              return;
            }

            if (resp.post_id) {
              setStatus("ok");
              setMessage("Access ready! Redirecting...");
              redirectTo("/library");
              return;
            }

            if (resp.purchase_id) {
              setStatus("ok");
              setMessage("Payment confirmed! Redirecting...");
              redirectTo(`/access/${resp.purchase_id}`);
              return;
            }

            setStatus("ok");
            setMessage("Payment confirmed! Redirecting...");
            redirectTo("/library");
            return;
          }
        } catch {
          if (cancelled) return;
          // A timeout/network error is uncertainty, never a failed payment or
          // permission to buy again. Only the server's paid result unlocks UI.
        } finally {
          clearTimeout(requestTimer);
          requestController = null;
        }

        if (cancelled) return;
        setStatus("pending");
        setMessage("Waiting for payment confirmation. Please don't pay again.");
        if (attempt < maxTries - 1) {
          await new Promise<void>((resolve) => {
            finishDelay = resolve;
            delayTimer = setTimeout(resolve, Math.min(1_000 * (attempt + 1), 10_000));
          });
          finishDelay = undefined;
        }
      }

      if (!cancelled) {
        setStatus("waiting");
        setMessage("Confirmation is taking longer than expected. Please don't pay again. Check the status below, or return to your Library later. Contact support if it remains pending.");
      }
    }

    runPurchaseFlow();
    return () => {
      cancelled = true;
      requestController?.abort();
      clearTimeout(requestTimer);
      clearTimeout(delayTimer);
      clearTimeout(redirectTimer);
      finishDelay?.();
    };
    // confirmOnce reads only sessionId; a manual check restarts this bounded,
    // cancelable status check, never Checkout or a payment-creation endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkRun, kindParam, router, sessionId]);

  const showFulfillment = status === "ok" && confirmedSessionId === sessionId && Boolean(fulfillment && fulfillmentMessage);

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
            : status === "waiting"
            ? "Confirmation pending"
            : "Heads up"}
        </h1>
        <p className="text-sm text-gray-600" role="status" aria-live="polite">{message}</p>

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

        {/* `status !== "error"` matters: bookingState is set to "processing" up
            front and no error path resets it, so without this guard every
            booking failure rendered a disabled "Processing…" button directly
            under the error headline — a stuck loading indicator on top of an
            error. Guarding here fixes all of the error exits at once instead of
            adding a reset to each, which a future branch would forget.
            The label is "Confirming your booking", not "Processing your
            payment": booking checkout is `mode: "setup"`
            (app/api/checkout/route.ts:908) and never charges the card. */}
        {bookingState !== "idle" && status !== "error" && (
          <div className="mt-6 flex items-center justify-center">
            <button
              onClick={() => {
                if (bookingUrl) window.location.assign(bookingUrl);
              }}
              className="px-4 py-2 text-sm rounded-lg bg-black text-white disabled:opacity-60"
              disabled={bookingState !== "ready" || !bookingUrl}
            >
              {bookingState === "ready" ? (kindParam === "booking" ? "Book" : "Schedule call") : "Confirming your booking..."}
            </button>
          </div>
        )}

        {!showFulfillment && (status === "error" || status === "waiting") && (
          <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
            {status === "waiting" && (
              <button
                onClick={() => {
                  setStatus("checking");
                  setMessage("Almost there...");
                  setCheckRun((value) => value + 1);
                }}
                className="px-4 py-2 text-sm rounded-lg bg-black text-white"
              >
                Check status
              </button>
            )}
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

function SuccessRoute() {
  const params = useSearchParams();
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const sessionId = params.get("session_id") || urlParams?.get("session_id") || "";
  const kindParam = params.get("kind") || urlParams?.get("kind") || "";
  // A different Checkout gets fresh state immediately, not an effect that
  // briefly renders the previous purchase's fulfillment links before resetting.
  return <SuccessPage key={JSON.stringify([sessionId, kindParam])} sessionId={sessionId} kindParam={kindParam} />;
}

export default function SuccessPageWrapper() {
  return (
    <Suspense fallback={<main className="min-h-svh bg-white flex items-center justify-center text-sm text-gray-500">Loading…</main>}>
      <SuccessRoute />
    </Suspense>
  );
}
