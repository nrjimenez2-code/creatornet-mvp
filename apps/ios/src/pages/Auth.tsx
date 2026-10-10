"use client";
import AuthView from "@/components/AuthView";
import { apiFetch as fetch } from "@/lib/apiFetch";
import { beginOAuth, cancelOAuth, pendingOAuth, validateNativeSession } from "../platform/auth";
import { AuthSkeleton } from "@/components/loading/Skeletons";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent } from "@/lib/posthog";
import { authNextPath } from "@/lib/browserSession";

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
        if (!(await validateNativeSession(session.user.id))) {
          if (mounted) setChecking(false);
          return;
        }
        if (!mounted) return;
        const next = authNextPath(window.location.search);
        if (next) {
          // Keep native navigation within the locally packaged client.
          router.replace(next);
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
  useEffect(() => {
    let mounted = true;
    const refreshPending = () => {
      void pendingOAuth().then(provider => { if (mounted) setOauthPending(provider); }).catch(() => { if (mounted) setOauthError('Could not read your pending sign-in. Please try again.'); });
    };
    refreshPending();
    window.addEventListener('creatornet:auth-pending-changed', refreshPending);
    return () => { mounted = false; window.removeEventListener('creatornet:auth-pending-changed', refreshPending); };
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
      await beginOAuth(provider);
    } catch (error: unknown) {
      setOauthError(
        error instanceof Error
          ? error.message
          : "Couldn't start sign-in. Try again.",
      );
      setOauthPending(null);
    }
    // Keep pending while the system browser owns the PKCE round-trip.
  }

  async function handleCancelOAuth() {
    try { await cancelOAuth(); setOauthPending(null); }
    catch { setOauthError('Could not cancel your sign-in. Please try again.'); }
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

  return <AuthView sessionError={sessionError} showForm={showForm} setShowForm={setShowForm} emailStep={emailStep} input={input} setInput={setInput} pendingEmail={pendingEmail} verificationCode={verificationCode} setVerificationCode={setVerificationCode} msg={msg} msgKind={msgKind} sending={sending} verifying={verifying} resendSeconds={resendSeconds} verifyWaitSeconds={verifyWaitSeconds} oauthPending={oauthPending} oauthError={oauthError} oauth={oauth} isVisible={isVisible} motionOK={motionOK} spot={spot} spotOn={spotOn} setSpotOn={setSpotOn} onMouseMove={onMouseMove} isInputEmpty={isInputEmpty} handleSignIn={handleSignIn} handleVerifyCode={handleVerifyCode} handleResendCode={handleResendCode} changeEmail={changeEmail} onSessionRetry={() => { setSessionError(null); setChecking(true); setSessionRetry(n => n + 1); }} onCancelOAuth={() => { void handleCancelOAuth(); }} />;
}
