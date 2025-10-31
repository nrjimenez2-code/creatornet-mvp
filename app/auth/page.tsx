"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AuthPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return setChecking(false);
      const { data: profile } = await supabase
        .from("profiles")
        .select("interests")
        .eq("id", session.user.id)
        .maybeSingle();
      if (profile?.interests?.length) router.replace("/dashboard");
      else router.replace("/onboarding");
    })();
  }, [router]);

  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    const isEmail = input.includes("@");
    try {
      if (isEmail) {
        await supabase.auth.signInWithOtp({
          email: input,
          options: { emailRedirectTo: `${currentOrigin}/auth` },
        });
        setMsg("📧 Check your email for the sign-in link.");
      } else {
        await supabase.auth.signInWithOtp({
          phone: input,
          options: { channel: "sms" },
        });
        setMsg("📲 Check your phone for the 6-digit code.");
      }
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setSending(false);
    }
  }

  async function oauth(provider: "google" | "apple") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${currentOrigin}/auth` },
    });
    if (error) alert(error.message);
  }

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center bg-white text-gray-800">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-white text-gray-900">
      <div className="w-full max-w-[380px] mx-auto text-center px-6">
        <h1 className="text-xl font-extrabold">SIGN UP FOR CREATORNET</h1>
        <p className="mt-1 text-[15px] text-gray-600 font-medium">
          <span className="text-[#7D5BD6]">Scroll</span>, Learn, Earn.
        </p>

        <button
          onClick={() => setShowForm(!showForm)}
          className="mt-6 w-full py-3 rounded-md bg-[#7D5BD6] text-white font-semibold hover:brightness-95 active:brightness-90 transition"
        >
          Phone or Email
        </button>

        <div className="flex items-center gap-2 my-5 text-xs text-gray-400">
          <span className="flex-1 h-px bg-gray-200" />
          or
          <span className="flex-1 h-px bg-gray-200" />
        </div>

        {/* Apple button */}
        <button
          onClick={() => oauth("apple")}
          className="w-full h-11 flex items-center justify-center gap-2 border border-gray-300 rounded-md hover:bg-gray-50 transition"
        >
          <AppleIcon className="w-5 h-5" />
          <span className="text-sm font-medium">Continue with Apple</span>
        </button>

        {/* Google button */}
        <button
          onClick={() => oauth("google")}
          className="mt-2 w-full h-11 flex items-center justify-center gap-2 border border-gray-300 rounded-md hover:bg-gray-50 transition"
        >
          <GoogleIcon className="w-5 h-5" />
          <span className="text-sm font-medium">Continue with Google</span>
        </button>

        {showForm && (
          <form onSubmit={handleSignIn} className="mt-6 space-y-3 text-left">
            <label className="block text-sm text-gray-600">Phone or Email</label>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="you@example.com or +15551234567"
              className="w-full h-11 rounded-md border border-gray-300 px-3 text-gray-900 focus:ring-2 focus:ring-[#7D5BD6]/50 focus:border-[#7D5BD6]"
            />
            <button
              type="submit"
              disabled={sending}
              className="w-full h-11 rounded-md bg-[#7D5BD6] text-white font-semibold disabled:opacity-60"
            >
              {sending ? "Sending…" : "Send link"}
            </button>
            {msg && <p className="text-sm text-center text-gray-600">{msg}</p>}
          </form>
        )}

        <p className="mt-5 text-sm text-gray-500">
          Have an account?{" "}
          <a href="#" className="text-[#7D5BD6] hover:underline">
            Log in
          </a>
        </p>
        <p className="mt-2 text-[12px] text-gray-400">
          By signing up, you agree to our{" "}
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

/* === icons === */
function AppleIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
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
