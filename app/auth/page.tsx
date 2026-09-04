"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent } from "@/lib/posthog";
import { buildAuthRedirectUrl } from "@/lib/authRedirect";
import {
  parseAuthErrorFromUrl,
  friendlyAuthError,
  urlWithoutAuthError,
} from "@/lib/authError";

const supabase = createClient();

export default function AuthPage() {
  const router = useRouter();
  const { session, loading } = useUser();

  // -------- Session redirect on load --------
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (loading) return;
    let mounted = true;
    (async () => {
      if (!session) {
        setChecking(false);
        return;
      }

      const { data: profile, error } = await supabase
        .from("profiles")
        .select("interests")
        .eq("id", session.user.id)
        .maybeSingle();

      if (error) {
        // Signed in but the interests check failed — don't strand the user on
        // the auth page looking like the login did nothing. The feed is the
        // safe default; onboarding re-offers itself from there if needed.
        console.error("Profile check error:", error);
        router.replace("/dashboard");
        return;
      }

      const interests = Array.isArray(profile?.interests)
        ? profile!.interests
        : [];

      router.replace(!interests?.length ? "/onboarding" : "/dashboard");
    })();

    return () => {
      mounted = false;
    };
  }, [loading, session, router]);

  // -------- UI state --------
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<"info" | "error">("info");
  const [sending, setSending] = useState(false);
  const [oauthPending, setOauthPending] = useState<"google" | "apple" | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // -------- Surface a sign-in that failed --------
  //
  // A failed OAuth round-trip comes back to this page with the reason in the
  // URL. lib/supabaseClient.ts uses the implicit flow, so that reason lands in
  // the hash fragment. Nothing in the app read it, so a failed sign-in rendered
  // an ordinary, error-free sign-in page — indistinguishable from "I clicked it
  // and nothing happened", which is how this was reported to us.
  //
  // Verified against production before writing this: the hash is still intact
  // seconds after load, so reading it from an effect is reliable and needs no
  // race-avoiding tricks.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = parseAuthErrorFromUrl(window.location.search, window.location.hash);
    if (!parsed) return;

    // Our own words only — see lib/authError.ts for why the provider's text is
    // never rendered.
    //
    // The set-state-in-effect rule below is disabled deliberately. It guards
    // against effects that re-derive state React could compute during render.
    // This is neither: it is a one-shot read of an external, immutable value
    // (the URL the provider redirected us to), it runs only when a sign-in
    // actually failed, and it cannot cascade because the dependency list is
    // empty. Both render-time alternatives are worse here — a lazy useState
    // initializer desynchronises server and client HTML, and useSyncExternalStore
    // needs a module-level cache that would replay a stale error after a
    // client-side navigation back to this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOauthError(friendlyAuthError(parsed));

    // The provider's own wording is kept for diagnosis, where no victim can
    // read it. This is also the first time an auth failure becomes visible in
    // analytics at all.
    console.warn("[auth] sign-in failed:", parsed.code, parsed.description);
    trackEvent("auth_oauth_failed", {
      error_code: parsed.code,
      error_description: parsed.description,
    });

    // Take the failure out of the address bar so a refresh does not replay it.
    window.history.replaceState(
      null,
      "",
      urlWithoutAuthError(window.location.pathname, window.location.search, window.location.hash)
    );
  }, []);

  // Spotlight state
  const [spot, setSpot] = useState<{ x: string; y: string }>({
    x: "50%",
    y: "50%",
  });
  const [spotOn, setSpotOn] = useState(false);
  const motionOK =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  // Track auth page visit
  useEffect(() => {
    trackEvent("signup_started");
  }, []);

  const isInputEmpty = useMemo(() => input.trim().length === 0, [input]);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;

    setMsg(null);
    setSending(true);

    const raw = input.trim();

    try {
      // Supabase must allow this exact URL in Authentication > URL Configuration.
      const redirectUrl = buildAuthRedirectUrl(
        process.env.NEXT_PUBLIC_SITE_URL,
        window.location.origin,
      );
      const { error } = await supabase.auth.signInWithOtp({
        email: raw,
        options: { emailRedirectTo: redirectUrl },
      });
      if (error) throw error;
      trackEvent("signup_completed", { method: "email" });
      setMsgKind("info");
      setMsg("📧 Check your inbox for the sign-in link!");
    } catch (err: any) {
      setMsgKind("error");
      setMsg(err?.message ?? "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  async function oauth(provider: "google" | "apple") {
    if (oauthPending) return;
    setOauthPending(provider);
    setOauthError(null);

    try {
      // Apple returns to Supabase first; Supabase then sends the user here.
      const redirectUrl = buildAuthRedirectUrl(
        process.env.NEXT_PUBLIC_SITE_URL,
        window.location.origin,
      );

      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: redirectUrl },
      });
      if (error) throw error;
    } catch (error: unknown) {
      setOauthError(
        error instanceof Error
          ? error.message
          : "Couldn't start sign-in. Try again.",
      );
      setOauthPending(null);
    }
    // On success the browser navigates to the provider — keep pending so the
    // buttons stay disabled during the redirect.
  }

  // Spotlight handlers (only when motion is OK)
  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!motionOK) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setSpot({ x: `${x}%`, y: `${y}%` });
  }

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white">
        <p className="text-sm text-gray-600">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-[#faf8ff] via-[#fdfbff] to-[#f6ecff] motion-safe:animate-[gradientShift_8s_ease_infinite]">
      {/* Animated gradient keyframes */}
      <style jsx global>{`
        @keyframes gradientShift {
          0% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
          100% {
            background-position: 0% 50%;
          }
        }
      `}</style>

      <div
        onMouseMove={onMouseMove}
        onMouseEnter={() => motionOK && setSpotOn(true)}
        onMouseLeave={() => motionOK && setSpotOn(false)}
        className={[
          "relative w-[420px] max-w-full px-8 py-10 text-center rounded-2xl bg-white/80",
          "shadow-[0_8px_40px_rgba(0,0,0,0.06)] backdrop-blur",
          "motion-safe:transition-all motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
          "motion-safe:hover:scale-[1.02] motion-safe:hover:shadow-[0_12px_50px_rgba(0,0,0,0.08)]",
          isVisible
            ? "motion-safe:opacity-100 motion-safe:translate-y-0"
            : "motion-safe:opacity-0 motion-safe:translate-y-3",
        ].join(" ")}
      >
        {/* Cursor spotlight (very subtle) */}
        {motionOK && (
          <div
            aria-hidden="true"
            className={[
              "pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300",
              spotOn ? "opacity-100" : "opacity-0",
            ].join(" ")}
            style={{
              background: `radial-gradient(450px circle at ${spot.x} ${spot.y}, rgba(147,112,219,0.14), transparent 55%)`,
              maskImage:
                "radial-gradient(400px circle at center, rgba(0,0,0,1), rgba(0,0,0,0.4) 60%, rgba(0,0,0,0) 100%)",
            }}
          />
        )}

        <h1 className="text-[26px] font-black text-zinc-900 tracking-wide">
          CREATORNET
        </h1>
        <p className="mt-1 text-[15px] font-semibold text-[#9370DB]">
          Scroll, Learn, Earn.
        </p>
        <p className="mt-2 text-[13px] text-gray-500">
          Short videos from creators who teach. Free to join.
        </p>

        <button
          onClick={() => setShowForm(!showForm)}
          className="w-full mt-6 py-3 text-[15px] font-semibold text-white bg-[#9370DB] rounded-md shadow-md hover:scale-[1.015] hover:shadow-lg active:scale-[0.99] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
        >
          Continue with email
        </button>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white px-3 text-sm text-gray-400 select-none">
              or
            </span>
          </div>
        </div>

        <button
          onClick={() => oauth("apple")}
          disabled={oauthPending !== null}
          aria-busy={oauthPending === "apple"}
          className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-md py-2.5 mb-2 bg-white hover:bg-gray-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <AppleIcon className="w-5 h-5 text-black" />
          <span className="font-medium text-gray-800 text-[14.5px]">
            {oauthPending === "apple" ? "Opening Apple…" : "Continue with Apple"}
          </span>
        </button>

        <button
          onClick={() => oauth("google")}
          disabled={oauthPending !== null}
          aria-busy={oauthPending === "google"}
          className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-md py-2.5 bg-white hover:bg-gray-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <GoogleIcon className="w-5 h-5" />
          <span className="font-medium text-gray-800 text-[14.5px]">
            {oauthPending === "google" ? "Opening Google…" : "Continue with Google"}
          </span>
        </button>

        {oauthError && (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {oauthError}
          </p>
        )}

        {showForm && (
          <div className="mt-6 text-left" aria-live="polite">
            <form onSubmit={handleSignIn} className="space-y-3">
              <label className="block text-sm text-gray-700">
                Email
              </label>
              <input
                type="email"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
              />
              <button
                type="submit"
                disabled={sending || isInputEmpty}
                aria-busy={sending}
                className="w-full py-2.5 text-white rounded-md font-semibold transition bg-zinc-900 hover:bg-zinc-800 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
              >
                {sending ? "Sending…" : "Send sign-in link"}
              </button>
              {msg && (
                <p
                  role={msgKind === "error" ? "alert" : "status"}
                  className={`text-xs text-center mt-1 ${
                    msgKind === "error" ? "text-red-600" : "text-gray-600"
                  }`}
                >
                  {msg}
                </p>
              )}
            </form>
          </div>
        )}

        <p className="mt-6 text-xs text-gray-500">
          By continuing, you agree to our{" "}
          <a
            href="/legal/terms"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Terms
          </a>
          ,{" "}
          <a
            href="/legal/privacy"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Privacy Policy
          </a>{" "}
          and{" "}
          <a
            href="/legal/cookies"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Cookies Policy
          </a>
          .
        </p>
        <p className="mt-2 text-xs text-gray-500">
          <a
            href="/legal/refunds"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Refund policy
          </a>
          {" · "}
          <a
            href="/legal/delivery"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Delivery &amp; cancellation
          </a>
          {" · "}
          <a
            href="/legal/support"
            className="underline hover:text-[#9370DB] transition-colors"
          >
            Support
          </a>
        </p>
      </div>
    </main>
  );
}

/* ---------- Inline Icons ---------- */
function AppleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.356 1.43c.02 1.2-.443 2.28-.998 3.01-.61.78-1.69 1.38-2.7 1.31-.12-1.02.44-2.28 1-3.01.62-.79 1.71-1.39 2.7-1.31ZM21.88 18.02c-.49 1.14-1.08 2.28-1.95 3.19-.83.87-1.78 1.76-3.12 1.79-1.36.03-1.8-.58-3.35-.58-1.56 0-2.03.56-3.38.6-1.38.03-2.44-.94-3.27-1.8-1.8-1.92-3.2-5.42-2.03-8.3.88-2.17 2.8-3.55 4.77-3.58 1.38-.03 2.52.68 3.34.68.83 0 2.27-.84 3.83-.72.65.03 2.47.26 3.64 2.03-3.09 1.67-2.59 6.06.92 7.4Z" />
    </svg>
  );
}

function GoogleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.15 0 5.98 1.08 8.21 3.2l6.15-6.15C34.9 3.02 29.87 1 24 1 14.64 1 6.5 6.38 3 14.26l7.46 5.79C12.08 14.58 17.55 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.68-.15-2.9-.47-4.16H24v7.89h12.67c-.25 2.03-1.64 5.08-4.72 7.13l7.24 5.61C43.89 37.85 46.5 31.83 46.5 24.5z"/>
      <path fill="#FBBC05" d="M10.46 27.04A14.5 14.5 0 0 1 9.5 24c0-1.05.18-2.07.47-3.04L2.5 14.26A23 23 0 0 0 1 24c0 3.66.87 7.1 2.5 10.15l7.46-7.11z"/>
      <path fill="#34A853" d="M24 47c6.48 0 11.92-2.14 15.9-5.85l-7.24-5.61c-2.02 1.39-4.72 2.23-8.66 2.23-6.45 0-11.92-5.08-13.04-11.73l-7.46 7.11C7.5 41.87 15.64 47 24 47z"/>
    </svg>
  );
}
