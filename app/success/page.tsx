// app/success/page.tsx
"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";

// Log immediately when module loads
if (typeof window !== "undefined") {
  console.log("[success-page] 📄 MODULE LOADED - Current URL:", window.location.href);
}

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
  const supabase = useMemo(() => {
    const client = createBrowserClient();
    console.error("[success-page] 🔧 Supabase client created");
    return client;
  }, []);
  
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

  // Log on every render - FORCE LOG
  if (typeof window !== "undefined") {
    const currentUrl = window.location.href;
    const currentSearch = window.location.search;
    console.error("[success-page] 🎬 COMPONENT RENDERED", { 
      sessionId, 
      kindParam, 
      bookingState,
      url: currentUrl,
      search: currentSearch,
      paramsFromHook: params.get("session_id"),
      paramsFromURL: urlParams?.get("session_id"),
    });
  }

  async function confirmOnce(): Promise<ConfirmResp> {
    // Use current origin to ensure we're hitting localhost, not Vercel
    const confirmUrl = typeof window !== "undefined" 
      ? `${window.location.origin}/api/confirm-purchase`
      : "/api/confirm-purchase";
    
    console.error("[success-page] 🌐 Calling confirm-purchase at:", confirmUrl);
    
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

  // Handle booking flow separately - RUN IMMEDIATELY ON MOUNT
  useEffect(() => {
    // CRITICAL: Read directly from URL - don't wait for React params
    if (typeof window === "undefined") return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const urlKind = urlParams.get("kind") || "";
    const urlSessionId = urlParams.get("session_id") || "";
    
    console.error("[success-page] 🔔🔔🔔 Booking useEffect triggered", { 
      urlKind,
      urlSessionId,
      url: window.location.href,
      hasRun: hasRunRef.current,
    });
    
    // Only run booking flow if kind=booking
    if (urlKind !== "booking") {
      console.error("[success-page] ⏭️ Not a booking, urlKind:", urlKind);
      return;
    }

    if (!urlSessionId) {
      console.error("[success-page] ⏭️ No sessionId in URL:", urlSessionId);
      return;
    }

    if (hasRunRef.current) {
      console.error("[success-page] ⏭️ Already ran booking flow");
      return;
    }

    console.error("[success-page] 🎯🎯🎯🎯🎯 STARTING BOOKING FLOW NOW!");
    hasRunRef.current = true;
    let cancelled = false;
    
    // Set state before starting async flow
    setBookingState("processing");
    setStatus("pending");
    setMessage("Processing your booking...");

    async function runBookingFlow(): Promise<void> {
      // Get session ID from URL directly
      const actualSessionId = urlSessionId;
      
      console.error("[success-page] 🚀🚀🚀 Starting booking flow function", { 
        urlSessionId,
        actualSessionId,
        cancelled 
      });
      
      if (cancelled) {
        console.error("[success-page] ⏭️ Cancelled before starting");
        return;
      }
      
      if (!actualSessionId) {
        console.error("[success-page] ❌❌❌ NO SESSION ID AVAILABLE");
        setStatus("error");
        setMessage("Missing session ID");
        return;
      }
      
      try {
        // Use current origin to ensure we're hitting localhost, not Vercel
        const confirmUrl = typeof window !== "undefined" 
          ? `${window.location.origin}/api/confirm-purchase`
          : "/api/confirm-purchase";
        
        console.error("[success-page] 📞📞📞 Step 1: Calling confirm-purchase", {
          session_id: actualSessionId,
          url: confirmUrl,
          origin: typeof window !== "undefined" ? window.location.origin : "N/A"
        });
        
        const res = await fetch(confirmUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ session_id: actualSessionId }),
        });
        
        console.error("[success-page] 📥 confirm-purchase response received, status:", res.status);
        const data = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) {
          console.error("[success-page] ❌ confirm-purchase failed:", data?.error || `HTTP ${res.status}`, data);
          setStatus("error");
          setMessage(`Failed to confirm booking: ${data?.error || "Unknown error"}`);
          return;
        }
        const resp = data as ConfirmResp;
        console.error("[success-page] ✅✅✅ confirm-purchase response:", resp);

        if (!("kind" in resp) || resp.kind !== "booking") {
          console.error("[success-page] ❌ Expected booking kind, got:", resp);
          setStatus("error");
          setMessage("Invalid booking session.");
          return;
        }

        const redirect = resp.booking_redirect_url || null;
        const respPostId = resp.post_id ?? null;
        const respCreatorId = resp.creator_id ?? null;
        console.error("[success-page] 📋 Booking details:", { 
          respPostId, 
          respCreatorId, 
          redirect, 
          hasSeeded: hasSeededRef.current 
        });
        
        // Step 2: Seed booking BEFORE redirecting - CRITICAL: Must complete before redirect
        if (!respPostId) {
          console.error("[success-page] ❌❌❌ NO POST_ID - Cannot create booking record!", {
            respPostId,
            respCreatorId,
            redirect,
            fullResponse: resp,
          });
          setStatus("error");
          setMessage("Missing post information. Please contact support with session ID: " + actualSessionId);
          return; // DO NOT REDIRECT if no post_id
        }

        if (hasSeededRef.current) {
          console.error("[success-page] ⏭️ Already seeded, redirecting");
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
        console.error("[success-page] 📞📞📞📞📞 Step 2: About to call seed endpoint", {
          post_id: respPostId,
          hasSeeded: hasSeededRef.current,
          timestamp: new Date().toISOString()
        });
        
        try {
          console.error("[success-page] 🔑 Step 2a: Getting auth session...");
          
          // Try multiple ways to get the token
          let accessToken: string | null = null;
          
          // Method 1: getSession()
          const {
            data: sessionData,
            error: sessionError
          } = await supabase.auth.getSession();
          
          console.error("[success-page] 🔑 Step 2b: getSession() result:", { 
            hasSession: !!sessionData.session,
            hasToken: !!sessionData.session?.access_token, 
            userId: sessionData.session?.user?.id,
            error: sessionError?.message
          });
          
          accessToken = sessionData.session?.access_token || null;
          
          // Method 2: getUser() if getSession() didn't work
          if (!accessToken) {
            console.error("[success-page] 🔑 Step 2c: Trying getUser()...");
            const {
              data: userData,
              error: userError
            } = await supabase.auth.getUser();
            
            console.error("[success-page] 🔑 getUser() result:", {
              hasUser: !!userData.user,
              error: userError?.message
            });
            
            // getUser() doesn't return token directly, need to get session again
            if (userData.user) {
              const { data: retrySession } = await supabase.auth.getSession();
              accessToken = retrySession.session?.access_token || null;
              console.error("[success-page] 🔑 Retry getSession() after getUser():", {
                hasToken: !!accessToken
              });
            }
          }
          
          if (!accessToken) {
            console.error("[success-page] ❌❌❌ No access token available for seeding");
            setStatus("error");
            setMessage("Authentication error. Please sign in again.");
            hasSeededRef.current = false; // Reset to allow retry
            return;
          }
          
          console.error("[success-page] 🔑✅ Token obtained:", {
            tokenLength: accessToken.length,
            tokenPreview: `${accessToken.substring(0, 20)}...${accessToken.substring(accessToken.length - 10)}`
          });
          
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          };
          
          // CRITICAL: Verify token is actually in headers before sending
          if (!headers.Authorization || !headers.Authorization.startsWith("Bearer ")) {
            console.error("[success-page] ❌❌❌ CRITICAL: Authorization header missing or invalid!", {
              hasHeader: !!headers.Authorization,
              headerValue: headers.Authorization || "MISSING",
              accessToken: accessToken ? `${accessToken.substring(0, 20)}...` : "NULL"
            });
            setStatus("error");
            setMessage("Authentication error. Please sign in again.");
            hasSeededRef.current = false;
            return;
          }
          
          console.error("[success-page] 📤📤📤 Step 2c: About to fetch /api/bookings/seed", { 
            post_id: respPostId,
            hasAuth: !!accessToken,
            tokenLength: accessToken.length,
            tokenPreview: `${accessToken.substring(0, 20)}...${accessToken.substring(accessToken.length - 10)}`,
            authHeaderPresent: !!headers.Authorization,
            authHeaderPreview: headers.Authorization ? `${headers.Authorization.substring(0, 30)}...` : "MISSING",
            url: "/api/bookings/seed",
            method: "POST"
          });
          
          // CRITICAL: Use current origin to ensure we're hitting localhost, not Vercel
          const apiUrl = typeof window !== "undefined" 
            ? `${window.location.origin}/api/bookings/seed`
            : "/api/bookings/seed";
          
          console.error("[success-page] 🌐 Using API URL:", apiUrl, {
            currentOrigin: typeof window !== "undefined" ? window.location.origin : "N/A",
            isLocalhost: typeof window !== "undefined" ? window.location.origin.includes("localhost") : false
          });
          
          const seedRes = await fetch(apiUrl, {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify({ post_id: respPostId }),
          });
          
          console.error("[success-page] 📥📥📥 Step 2d: Seed fetch response received", {
            status: seedRes.status,
            ok: seedRes.ok,
            statusText: seedRes.statusText,
            headers: Object.fromEntries(seedRes.headers.entries())
          });
          
          console.error("[success-page] 📥 Step 2d: Seed fetch completed", {
            status: seedRes.status,
            ok: seedRes.ok,
            statusText: seedRes.statusText
          });
          
          const seedData = await seedRes.json().catch(() => ({}));
          console.error("[success-page] ✅ Seed response:", { 
            status: seedRes.status, 
            ok: seedRes.ok, 
            data: seedData 
          });
          
          if (!seedRes.ok) {
            console.error("[success-page] ❌❌❌ Seed failed:", seedData?.error || `HTTP ${seedRes.status}`, seedData);
            setStatus("error");
            setMessage(`Failed to create booking: ${seedData?.error || "Unknown error"}`);
            hasSeededRef.current = false; // Reset to allow retry
            return; // DO NOT REDIRECT if seed failed
          }
          
          console.error("[success-page] ✅✅✅✅✅ SEED SUCCESS - Booking record created:", seedData);
          // Step 3: ONLY redirect after successful seed
          setBookingUrl(redirect);
          setBookingState("ready");
          setStatus("ok");
          setMessage(redirect ? "Booking confirmed! Redirecting..." : "Booking confirmed.");
          if (redirect) {
            console.log("[success-page] 🔄 Step 3: Redirecting to:", redirect);
            setTimeout(() => {
              console.log("[success-page] 🚀 EXECUTING REDIRECT NOW");
              window.location.assign(redirect);
            }, 2000);
          }
        } catch (seedErr: any) {
          console.error("[success-page] ❌ Seed error:", seedErr);
          setStatus("error");
          setMessage(`Error creating booking: ${seedErr?.message || "Unknown error"}`);
          hasSeededRef.current = false; // Reset to allow retry
          // DO NOT REDIRECT if seed errored
        }
      } catch (err: any) {
        console.error("[success-page] ❌ Booking flow error:", err);
        setStatus("error");
        setMessage(`Error processing booking: ${err?.message || "Unknown error"}`);
      }
    }

    // Run the booking flow
    runBookingFlow().catch((err) => {
      console.error("[success-page] ❌ Unhandled error in booking flow:", err);
      setStatus("error");
      setMessage(`Error: ${err?.message || "Unknown error"}`);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run ONCE on mount - check URL params directly inside

  // Handle regular purchase flow
  useEffect(() => {
    console.log("[success-page] 🔔 Purchase useEffect triggered", { sessionId, kindParam });
    let cancelled = false;

    // Skip if this is a booking
    if (kindParam === "booking") {
      return;
    }

    async function runPurchaseFlow() {
      console.log("[success-page] 🚀 Starting purchase flow function", { sessionId });
      if (!sessionId) {
        console.error("[success-page] ❌ Missing sessionId");
        setStatus("error");
        setMessage("Missing session id.");
        return;
      }

      while (!cancelled && triesRef.current < maxTries) {
        try {
          console.log("[success-page] calling confirm-purchase, attempt:", triesRef.current + 1);
          const resp = await confirmOnce();
          console.log("[success-page] confirm-purchase response:", resp);

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
  }, [kindParam, router, sessionId, supabase]);

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
  if (typeof window !== "undefined") {
    console.log("[success-page] 🌐 PAGE WRAPPER RENDERED - URL:", window.location.href);
    console.log("[success-page] 🌐 SEARCH PARAMS:", window.location.search);
    // Force log to ensure it's visible
    console.error("[success-page] 🔴 FORCE LOG - This should always appear");
  }
  return (
    <Suspense fallback={<main className="min-h-[70vh] flex items-center justify-center text-sm text-gray-500">Loading…</main>}>
      <SuccessPage />
    </Suspense>
  );
}
