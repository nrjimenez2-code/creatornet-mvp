"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";

const supabase = createClient();

export default function AuthPage() {
  const router = useRouter();

  // -------- Session redirect on load --------
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;
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
        console.error("Profile check error:", error);
        setChecking(false);
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
  }, [router]);

  // -------- UI state --------
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [phoneForOtp, setPhoneForOtp] = useState<string | null>(null);

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

  const isInputEmpty = useMemo(() => input.trim().length === 0, [input]);

  function normalizePhone(raw: string) {
    const s = raw.trim();
    if (s.startsWith("+")) return s;
    const digits = s.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return s.startsWith("+") ? s : `+${digits || s}`;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;

    setMsg(null);
    setSending(true);

    const raw = input.trim();
    const isPhone =
      raw.startsWith("+") || (/^\D*\d[\d\D]*$/.test(raw) && !raw.includes("@"));

    try {
      if (isPhone) {
        const phone = normalizePhone(raw);
        const { error } = await supabase.auth.signInWithOtp({
          phone,
          options: { channel: "sms" },
        });
        if (error) throw error;
        setPhoneForOtp(phone);
        setCodeSent(true);
        setMsg("📲 We sent you a 6-digit code via SMS.");
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email: raw,
          options: { emailRedirectTo: `${window.location.origin}/auth` },
        });
        if (error) throw error;
        setMsg("📧 Check your inbox for the sign-in link!");
      }
    } catch (err: any) {
      setMsg(err?.message ?? "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  async function verifySmsCode(e: React.FormEvent) {
    e.preventDefault();
    if (!phoneForOtp) return setMsg("Missing phone number.");
    if (!otp) return setMsg("Enter the 6-digit code.");

    setSending(true);
    setMsg(null);
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone: phoneForOtp,
        token: otp,
        type: "sms",
      });
      if (error) throw error;
      window.location.href = "/auth";
    } catch (err: any) {
      setMsg(err?.message ?? "Invalid code.");
    } finally {
      setSending(false);
    }
  }

  function resetSmsFlow() {
    setCodeSent(false);
    setOtp("");
    setPhoneForOtp(null);
    setMsg(null);
  }

  async function oauth(provider: "google" | "apple") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth` },
    });
    if (error) alert(error.message);
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

        <button
          onClick={() => setShowForm(!showForm)}
          className="w-full mt-6 py-3 text-[15px] font-semibold text-white bg-[#9370DB] rounded-md shadow-md hover:scale-[1.015] hover:shadow-lg active:scale-[0.99] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
        >
          Phone or Email
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
          className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-md py-2.5 mb-2 bg-white hover:bg-gray-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
        >
          <AppleIcon className="w-5 h-5 text-black" />
          <span className="font-medium text-gray-800 text-[14.5px]">
            Continue with Apple
          </span>
        </button>

        <button
          onClick={() => oauth("google")}
          className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-md py-2.5 bg-white hover:bg-gray-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
        >
          <GoogleIcon className="w-5 h-5" />
          <span className="font-medium text-gray-800 text-[14.5px]">
            Continue with Google
          </span>
        </button>

        {showForm && (
          <div className="mt-6 text-left" aria-live="polite">
            {!codeSent ? (
              <form onSubmit={handleSignIn} className="space-y-3">
                <label className="block text-sm text-gray-700">
                  Phone or Email
                </label>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="you@example.com or +15551234567"
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
                  {sending ? "Sending…" : "Send sign-in link or code"}
                </button>
                {msg && (
                  <p className="text-xs text-center text-gray-600 mt-1">{msg}</p>
                )}
              </form>
            ) : (
              <form onSubmit={verifySmsCode} className="space-y-3">
                <label className="block text-sm text-gray-700">
                  Enter 6-digit code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoFocus
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-gray-900 tracking-[0.3em] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
                />
                <button
                  type="submit"
                  disabled={sending || otp.trim().length !== 6}
                  aria-busy={sending}
                  className="w-full py-2.5 text-white rounded-md font-semibold transition bg-zinc-900 hover:bg-zinc-800 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
                >
                  {sending ? "Verifying…" : "Verify & continue"}
                </button>
                <button
                  type="button"
                  onClick={resetSmsFlow}
                  className="w-full text-center text-xs text-gray-600 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2 rounded"
                >
                  Resend or change number
                </button>
                {msg && (
                  <p className="text-xs text-center text-gray-600 mt-1">{msg}</p>
                )}
              </form>
            )}
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
