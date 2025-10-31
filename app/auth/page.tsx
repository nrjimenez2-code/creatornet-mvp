"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AuthPage() {
  const router = useRouter();

  // Build a redirectTo that works on laptop (localhost) and phone (LAN IP)
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  useEffect(() => {
    setRedirectTo(`${window.location.origin}/auth/callback`);
  }, []);

  // ---------- Redirect-on-load logic ----------
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      if (!session) {
        setChecking(false); // show auth UI
        return;
      }

      // Signed in — check profile.interests
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

      if (!interests || interests.length === 0) {
        router.replace("/onboarding");
      } else {
        router.replace("/dashboard");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [router]);

  // ---------- UI state ----------
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  // SMS OTP state
  const [codeSent, setCodeSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [phoneForOtp, setPhoneForOtp] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

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
          options: {
            emailRedirectTo: redirectTo ?? undefined, // ★ changed
          },
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
      options: {
        redirectTo: redirectTo ?? undefined, // ★ changed
      },
    });
    if (error) alert(error.message);
  }

  if (checking || !redirectTo) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white">
        <p className="text-sm text-gray-600">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-white">
      <div
        className={`w-[360px] max-w-full px-6 py-8 text-center rounded-xl transition-all duration-700 ease-out ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
        }`}
      >
        <h1 className="text-[24px] font-black text-zinc-900 uppercase whitespace-nowrap text-center -ml-[24px]">
          CONTINUE TO CREATORNET
        </h1>
        <p className="mt-2 text-[16px] font-semibold text-[#6B47DC]">
          Scroll, Learn, Earn.
        </p>

        <button
          onClick={() => setShowForm(!showForm)}
          className="w-full mt-6 py-3 text-[16px] font-semibold text-white bg-[#9370DB] rounded-md shadow-md hover:brightness-95 active:brightness-90 transition"
        >
          Phone or Email
        </button>

        <div className="text-sm text-gray-500 my-4">or</div>

        <button
          onClick={() => oauth("apple")}
          className="w-full flex items-center justify-center gap-2 border border-gray-300 rounded-md py-2.5 mb-2 bg-white hover:bg-gray-50 transition"
        >
          <AppleIcon className="w-5 h-5 text-black" />
          <span className="font-medium text-gray-800 text-[15px]">
            Continue with Apple
          </span>
        </button>

        <button
          onClick={() => oauth("google")}
          className="w-full flex items-center justify-center gap-2 border border-gray-300 rounded-md py-2.5 bg-white hover:bg-gray-50 transition"
        >
          <GoogleIcon className="w-5 h-5" />
          <span className="font-medium text-gray-800 text-[15px]">
            Continue with Google
          </span>
        </button>

        {showForm && (
          <div className="mt-6 text-left">
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
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/30 focus:border-[#9370DB]"
                />
                <button
                  type="submit"
                  disabled={sending}
                  className="w-full py-2.5 text-white bg-zinc-900 rounded-md font-semibold hover:bg-zinc-800 disabled:opacity-60 transition"
                >
                  {sending ? "Sending…" : "Send sign-in link or code"}
                </button>
                {msg && (
                  <p className="text-xs text-center text-gray-600 mt-1">
                    {msg}
                  </p>
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
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-gray-900 tracking-[0.3em] focus:outline-none focus:ring-4 focus:ring-[#9370DB]/30 focus:border-[#9370DB]"
                />
                <button
                  type="submit"
                  disabled={sending}
                  className="w-full py-2.5 text-white bg-zinc-900 rounded-md font-semibold hover:bg-zinc-800 disabled:opacity-60 transition"
                >
                  {sending ? "Verifying…" : "Verify & continue"}
                </button>
                <button
                  type="button"
                  onClick={resetSmsFlow}
                  className="w-full text-center text-xs text-gray-600 underline"
                >
                  Resend or change number
                </button>
                {msg && (
                  <p className="text-xs text-center text-gray-600 mt-1">
                    {msg}
                  </p>
                )}
              </form>
            )}
          </div>
        )}

        <p className="mt-6 text-xs text-gray-500">
          By continuing, you agree to our{" "}
          <a href="#" className="underline">
            Terms
          </a>
          ,{" "}
          <a href="#" className="underline">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="#" className="underline">
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
