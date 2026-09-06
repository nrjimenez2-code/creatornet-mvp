"use client";

import { useEffect, useId, useState } from "react";
import { useUser } from "@/lib/useUser";

/**
 * "Get the blue check" card for the creator's Edit Profile page.
 *
 * Talks only to /api/verification (GET for status, POST to request a code).
 * The instructions text comes from the API so lib/verification.ts stays the
 * one place that decides where the code goes. No supabase.auth calls here —
 * the session comes from useUser() and rides along as a Bearer token.
 */

type RequestStatus = "code_issued" | "approved" | "rejected" | "revoked";
type Platform = "instagram" | "tiktok";

interface VerificationRequest {
  id: string;
  platform: Platform;
  handle: string;
  status: RequestStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  code: string | null;
}

interface StatusPayload {
  request: VerificationRequest | null;
  instructions: string;
}

const PLATFORM_OPTIONS: Array<{ value: Platform; label: string }> = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
];

const STATUS_HEADLINE: Record<RequestStatus, string> = {
  code_issued: "Your code is ready",
  approved: "You're verified",
  rejected: "We couldn't find your code",
  revoked: "Your blue check was removed",
};

const INPUT_CLASS =
  "w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#4A35C7]";

function platformLabel(platform: Platform): string {
  return PLATFORM_OPTIONS.find((p) => p.value === platform)?.label ?? platform;
}

function authHeaders(accessToken: string | null): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export default function AuthenticityVerificationCard() {
  const { session, loading: sessionLoading } = useUser();
  const accessToken = session?.access_token ?? null;
  const platformId = useId();
  const handleId = useId();

  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [handle, setHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Load the current status once the session is known. State is only touched
  // after the network round trip, never synchronously in the effect body.
  useEffect(() => {
    if (sessionLoading || !accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/verification", { headers: authHeaders(accessToken) });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const payload = (await res.json()) as StatusPayload;
        if (cancelled) return;
        setStatus(payload);
        setLoadError(null);
      } catch (err) {
        console.error("[verification card] load failed:", err);
        if (!cancelled) {
          setLoadError("Couldn't load your verification status. Refresh to try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, accessToken]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(accessToken) },
        body: JSON.stringify({ platform, handle }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<StatusPayload> & { error?: string };
      if (res.status === 409 && body.request) {
        // Someone double-clicked, or a code already exists: show it.
        setStatus((prev) => ({ request: body.request ?? null, instructions: body.instructions ?? prev?.instructions ?? "" }));
        return;
      }
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setStatus({ request: body.request ?? null, instructions: body.instructions ?? "" });
      setHandle("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Couldn't request a code. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[verification card] copy failed:", err);
    }
  }

  const request = status?.request ?? null;
  const showForm = !request || request.status === "rejected" || request.status === "revoked";

  return (
    <section
      aria-labelledby="authenticity-card-title"
      className="rounded-2xl border border-blue-100 bg-blue-50/40 p-5"
    >
      <h2 id="authenticity-card-title" className="text-base font-semibold">
        Get the blue check
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Prove your Instagram or TikTok is really yours and we&apos;ll show a blue shield next to your name.
      </p>

      {loadError ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {loadError}
        </p>
      ) : null}

      {request ? (
        <div className="mt-4 rounded-xl border border-white bg-white/80 p-4" aria-live="polite">
          <p className="text-sm font-semibold">{STATUS_HEADLINE[request.status]}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            {platformLabel(request.platform)} @{request.handle}
          </p>

          {request.status === "code_issued" && request.code ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-[#4A35C7]/10 px-3 py-1.5 font-mono text-lg font-bold tracking-widest text-[#4A35C7]">
                  {request.code}
                </code>
                <button
                  type="button"
                  onClick={() => void copyCode(request.code as string)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-gray-50"
                >
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
              <p className="mt-3 text-sm text-gray-700">{status?.instructions}</p>
            </>
          ) : null}

          {request.status === "approved" ? (
            <p className="mt-2 text-sm text-gray-700">
              Your blue shield is live on your public profile. You can remove the code from your bio.
            </p>
          ) : null}

          {(request.status === "rejected" || request.status === "revoked") && request.reason ? (
            <p className="mt-2 text-sm text-gray-700">Note from CreatorNet: {request.reason}</p>
          ) : null}
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <div>
              <label htmlFor={platformId} className="mb-1 block text-sm font-medium">
                Platform
              </label>
              <select
                id={platformId}
                value={platform}
                onChange={(event) => setPlatform(event.target.value as Platform)}
                className={INPUT_CLASS}
              >
                {PLATFORM_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={handleId} className="mb-1 block text-sm font-medium">
                Your handle
              </label>
              <input
                id={handleId}
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                className={INPUT_CLASS}
                placeholder="@yourname"
                autoComplete="off"
                inputMode="text"
                maxLength={31}
                required
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting || sessionLoading}
            className="rounded-xl bg-[#4A35C7] px-4 py-2 text-sm font-medium text-white hover:bg-[#3D2BA3] disabled:opacity-60"
          >
            {submitting ? "Requesting…" : request ? "Request a new code" : "Get my code"}
          </button>
          {submitError ? (
            <p role="alert" className="text-sm text-red-600">
              {submitError}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
