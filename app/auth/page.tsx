"use client";
import AuthView from "@/components/AuthView";
import { AuthSkeleton } from "@/components/loading/Skeletons";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent } from "@/lib/posthog";
import { authNextPath, prepareSessionNavigation } from "@/lib/browserSession";
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
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionRetry, setSessionRetry] = useState(0);
  useEffect(() => {
    if (loading) return;
    let mounted = true;
    (async () => {
      if (!session) {
        setChecking(false);
        return;
      }

      try {
        if (!(await prepareSessionNavigation(supabase))) {
          if (mounted) setChecking(false);
          return;
        }
        if (!mounted) return;
        const next = authNextPath(window.location.search);
        if (next) {
          // A full navigation avoids reusing a prefetched unauthenticated redirect.
          window.location.replace(next);
          return;
        }
        const { data: profile, error } = await supabase
          .from("profiles").select("interests").eq("id", session.user.id).maybeSingle();
        if (!mounted) return;
        if (error) throw Error("Could not load your profile. Please try again.");
        const interests = Array.isArray(profile?.interests) ? profile.interests : [];
        router.replace(interests.length ? "/dashboard" : "/onboarding");
      } catch (error) {
        if (!mounted) return;
        setChecking(false);
        setSessionError(error instanceof Error ? error.message : "Could not verify your sign-in. Please try again.");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [loading, session, router, sessionRetry]);

  // -------- UI state --------
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [emailStep, setEmailStep] = useState<"email" | "code">("email");
  const [pendingEmail, setPendingEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<"info" | "error">("info");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [verifyWaitSeconds, setVerifyWaitSeconds] = useState(0);
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

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (verifyWaitSeconds <= 0) return;
    const timer = window.setInterval(() => setVerifyWaitSeconds(s => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [verifyWaitSeconds]);

  // Track auth page visit
  useEffect(() => {
    trackEvent("signup_started");
  }, []);

  const isInputEmpty = useMemo(() => input.trim().length === 0, [input]);

  async function requestEmailCode(email: string) {
    await submitEmailCode({ email, action: "send" });
  }

  async function submitEmailCode(body: { email: string; action: "send" | "verify"; code?: string }) {
    const response = await fetch("/api/auth/email-code", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.retryAfter > 0) setResendSeconds(result.retryAfter);
      if (result.locked || (body.action === "verify" && result.retryAfter > 0)) setVerifyWaitSeconds(result.retryAfter);
      throw new Error(result.error || "Unable to sign in. Please try again.");
    }
    return result;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;

    setMsg(null);
    setSending(true);

    const raw = input.trim();

    try {
      await requestEmailCode(raw);
      setPendingEmail(raw);
      setVerificationCode("");
      setEmailStep("code");
      setResendSeconds(60);
      setMsgKind("info");
      setMsg("Enter the six-digit code we sent to your email.");
    } catch (error: unknown) {
      setMsgKind("error");
      setMsg(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (verifying || verifyWaitSeconds > 0) return;

    const token = verificationCode.trim();
    if (!/^\d{6}$/.test(token)) {
      setMsgKind("error");
      setMsg("Enter the complete six-digit code.");
      return;
    }

    setMsg(null);
    setVerifying(true);

    try {
      const result = await submitEmailCode({ email: pendingEmail, code: token, action: "verify" });
      const { error } = await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      if (error) throw error;
      trackEvent("signup_completed", { method: "email" });
      setMsgKind("info");
      setMsg("You're signed in. Opening CreatorNet…");
    } catch (error: unknown) {
      setMsgKind("error");
      setMsg(
        error instanceof Error
          ? error.message
          : "That code could not be verified. Request a new one and try again.",
      );
    } finally {
      setVerifying(false);
    }
  }

  async function handleResendCode() {
    if (sending || resendSeconds > 0) return;
    setMsg(null);
    setSending(true);
    try {
      await requestEmailCode(pendingEmail);
      setResendSeconds(60);
      setMsgKind("info");
      setMsg("A new six-digit code is on the way.");
    } catch (error: unknown) {
      setMsgKind("error");
      setMsg(error instanceof Error ? error.message : "Unable to resend the code.");
    } finally {
      setSending(false);
    }
  }

  function changeEmail() {
    setEmailStep("email");
    setPendingEmail("");
    setVerificationCode("");
    setResendSeconds(0);
    setVerifyWaitSeconds(0);
    setMsg(null);
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
        window.location.search,
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
    return <AuthSkeleton />;
  }

  return <AuthView sessionError={sessionError} showForm={showForm} setShowForm={setShowForm} emailStep={emailStep} input={input} setInput={setInput} pendingEmail={pendingEmail} verificationCode={verificationCode} setVerificationCode={setVerificationCode} msg={msg} msgKind={msgKind} sending={sending} verifying={verifying} resendSeconds={resendSeconds} verifyWaitSeconds={verifyWaitSeconds} oauthPending={oauthPending} oauthError={oauthError} oauth={oauth} isVisible={isVisible} motionOK={motionOK} spot={spot} spotOn={spotOn} setSpotOn={setSpotOn} onMouseMove={onMouseMove} isInputEmpty={isInputEmpty} handleSignIn={handleSignIn} handleVerifyCode={handleVerifyCode} handleResendCode={handleResendCode} changeEmail={changeEmail} onSessionRetry={() => { setSessionError(null); setChecking(true); setSessionRetry(n => n + 1); }} />;
}
