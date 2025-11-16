// app/success/page.tsx
"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";

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
  const supabase = useMemo(() => createBrowserClient(), []);
  const sessionId = params.get("session_id") || "";
  const kindParam = params.get("kind") || "";
  const [status, setStatus] = useState<"checking" | "ok" | "pending" | "error">("checking");
  const [message, setMessage] = useState("Almost there...");
  const triesRef = useRef(0);
  const maxTries = 6; // ~10-12s total with backoff
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [bookingState, setBookingState] = useState<"idle" | "processing" | "ready">("idle");
  const [fulfillment, setFulfillment] = useState<FulfillmentProduct | null>(null);
  const [fulfillmentMessage, setFulfillmentMessage] = useState<string | null>(null);
  const hasSeededRef = useRef(false);

  async function confirmOnce(): Promise<ConfirmResp> {
    const res = await fetch("/api/confirm-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    return data as ConfirmResp;
  }

  useEffect(() => {
    let cancelled = false;

    if (kindParam === "booking" && bookingState === "idle") {
      setBookingState("processing");
      setStatus("pending");
      setMessage("Processing your booking...");
    }

    async function run() {
      if (!sessionId) {
        setStatus("error");
        setMessage("Missing session id.");
        return;
      }

      while (!cancelled && triesRef.current < maxTries) {
        try {
          const resp = await confirmOnce();

          if ("kind" in resp && resp.kind === "booking") {
            const redirect = resp.booking_redirect_url || null;
            const respPostId = resp.post_id ?? null;
            const respCreatorId = resp.creator_id ?? null;
            if (respPostId && !hasSeededRef.current) {
              hasSeededRef.current = true;
              try {
                const {
                  data: sessionData,
                } = await supabase.auth.getSession();
                const accessToken = sessionData.session?.access_token;
                const headers: Record<string, string> = {
                  "Content-Type": "application/json",
                };
                if (accessToken) {
                  headers.Authorization = `Bearer ${accessToken}`;
                }
                await fetch("/api/bookings/seed", {
                  method: "POST",
                  headers,
                  credentials: "include",
                  body: JSON.stringify({ post_id: respPostId }),
                });
              } catch (seedErr) {
                console.error("[booking-seed] error:", seedErr);
              }
            }
            setBookingUrl(redirect);
            setBookingState("ready");
            setStatus("ok");
            setMessage(redirect ? "Booking confirmed! Redirecting..." : "Booking confirmed.");
            if (redirect) {
              setTimeout(() => {
                window.location.assign(redirect);
              }, 900);
            }
            return;
          }

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
              // setTimeout(() => router.replace(`/access/${resp.purchase_id}`), 700);
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
        setMessage("We couldn’t verify your payment yet. It may still post in a minute—check your Library.");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [bookingState, kindParam, router, sessionId, supabase]);

  const showFulfillment = Boolean(fulfillment && fulfillmentMessage);

  return (
    <main className="min-h-[70vh] flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="mb-4 animate-pulse text-4xl">✨</div>
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
              className="px-4 py-2 text-sm rounded-lg border"
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function SuccessPageWrapper() {
  return (
    <Suspense fallback={<main className="min-h-[70vh] flex items-center justify-center text-sm text-gray-500">Loading…</main>}>
      <SuccessPage />
    </Suspense>
  );
}
