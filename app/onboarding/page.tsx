"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent } from "@/lib/posthog";

type Interest =
  | "Entrepreneurship"
  | "Money & Investing"
  | "Social Media Growth"
  | "Content Creation"
  | "Online Skills"
  | "Health & Fitness"
  | "Self Improvement"
  | "Tech & AI Automation";

const OPTIONS: Interest[] = [
  "Entrepreneurship",
  "Money & Investing",
  "Social Media Growth",
  "Content Creation",
  "Online Skills",
  "Health & Fitness",
  "Self Improvement",
  "Tech & AI Automation",
];

export default function Page() {
  const router = useRouter();
  const supabase = createClient();

  const { userId } = useUser();
  const [username, setUsername] = useState("");
  const [usernameOk, setUsernameOk] = useState<boolean | null>(null);
  const [usernameErr, setUsernameErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Interest[]>([]);
  const [saving, setSaving] = useState(false);

  const debounced = useDebounced(username, 350);

  // Check username availability
  useEffect(() => {
    if (!debounced || !userId) return;

    let cancelled = false;
    (async () => {
      const lower = debounced.trim().toLowerCase();

      const valid = /^[a-z0-9._]{3,20}$/.test(lower);
      if (!valid) {
        setUsernameOk(false);
        setUsernameErr(
          "3–20 chars, a–z, 0–9, dot or underscore only (no spaces)."
        );
        return;
      }

      const { data, error } = await supabase.rpc("is_username_available", {
        u: lower,
        exclude_id: userId,
      });

      if (cancelled) return;
      if (error) {
        console.error(error);
        setUsernameOk(null);
        setUsernameErr("Couldn't check username. Try again.");
        return;
      }

      setUsernameOk(Boolean(data)); // true = available
      setUsernameErr(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [debounced, userId, supabase]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const lower = username.trim().toLowerCase();
    setSaving(true);

    // INSERT first, then fall back to UPDATE. Signing up creates an auth user
    // but NO profiles row (there is no database trigger), so the original
    // `.update().eq("id", userId)` matched zero rows, returned no error, and
    // sent the user to /dashboard having saved nothing — which bounced them
    // straight back here on their next visit.
    //
    // Deliberately NOT `.upsert()`: PostgREST compiles it to
    //   INSERT ... ON CONFLICT("id") DO UPDATE SET "id" = EXCLUDED."id", ...
    // and migration 009 revoked table-level INSERT/UPDATE, granting
    // `authenticated` INSERT on `id` but NOT UPDATE on it. The upsert therefore
    // fails with 42501 permission denied before it ever runs. Verified against
    // production: has_column_privilege(authenticated, profiles, id, UPDATE) is
    // false, and pg_stat_statements shows PostgREST emitting the id assignment.
    // Insert (id, username, interests) and update (username, interests) are
    // both within the granted column lists.
    let saveError = null as { code?: string; message: string } | null;

    const insertRes = await supabase
      .from("profiles")
      .insert({ id: userId, username: lower, interests: selected });

    if (insertRes.error) {
      const isDuplicate = insertRes.error.code === "23505";
      const isOwnRowConflict =
        isDuplicate && /profiles_pkey/i.test(insertRes.error.message);

      if (isOwnRowConflict) {
        // The row already exists (a returning user, or a row created by the
        // profile editor / Stripe onboarding). Update the two columns we own.
        const updateRes = await supabase
          .from("profiles")
          .update({ username: lower, interests: selected })
          .eq("id", userId);
        saveError = updateRes.error;
      } else {
        saveError = insertRes.error;
      }
    }

    if (saveError) {
      console.error(saveError);
      // A username taken between the availability check and this save comes
      // back as a raw constraint violation; do not show that to the user.
      const takenUsername =
        saveError.code === "23505" &&
        /profiles_username_unique/i.test(saveError.message);
      setUsernameErr(
        takenUsername
          ? "That username was just taken — please pick another."
          : "Could not save your profile. Please try again."
      );
      setSaving(false);
      return;
    }

    trackEvent("onboarding_completed", { user_id: userId, interests: selected });
    router.replace("/dashboard");
  }

  // Must match resolveOnboardingRedirect() in lib/onboardingGate.ts, which
  // sends the user back here when `!username || interests.length === 0`. That
  // gate now runs on "/" AND on the /dashboard layout, so if Continue were
  // enabled with no interests picked, the profile would save and the very next
  // page would bounce them straight back — the same loop this page fixes.
  const canContinue =
    !!userId &&
    username.trim().length >= 3 &&
    usernameOk === true &&
    selected.length > 0;

  const helperText = useMemo(() => {
    if (usernameErr) return usernameErr;
    if (usernameOk === true) return "✅ Username available";
    if (usernameOk === false) return "❌ Username unavailable";
    return "";
  }, [usernameErr, usernameOk]);

  return (
    <main className="min-h-svh bg-white flex items-start sm:items-center justify-center px-4 sm:px-6 py-10 sm:py-12">
      <div className="w-full max-w-md">
        <h1 className="text-2xl sm:text-3xl md:text-[32px] font-extrabold text-[#4A35C7] tracking-wide uppercase text-left">
          CHOOSE YOUR INTERESTS
        </h1>

        <p className="text-gray-800 text-sm mt-3 text-left">
          Pick a few and claim your username to personalize CreatorNet.
        </p>

        <form onSubmit={onSave} className="mt-6 space-y-5">
          <div className="text-left">
            <label className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="yourname"
              className={`mt-1 w-full rounded-md border px-3 py-2 text-base text-gray-900 focus:ring-4 ${
                usernameOk === false
                  ? "border-red-400 focus:ring-red-200"
                  : "border-gray-300 focus:ring-[#9370DB]/30"
              }`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              suppressHydrationWarning
            />
            {helperText && (
              <p
                className={`text-sm mt-1 ${
                  usernameOk === true
                    ? "text-green-600"
                    : usernameOk === false
                    ? "text-red-600"
                    : "text-gray-600"
                }`}
              >
                {helperText}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-3">
            {OPTIONS.map((opt) => {
              const active = selected.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() =>
                    setSelected((prev) =>
                      prev.includes(opt)
                        ? prev.filter((x) => x !== opt)
                        : [...prev, opt]
                    )
                  }
                  className={`rounded-md border px-3 sm:px-4 py-3 text-xs sm:text-sm font-medium leading-snug text-center transition ${
                    active
                      ? "bg-[#4A35C7] text-white border-[#4A35C7]"
                      : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                  }`}
                  suppressHydrationWarning
                >
                  {opt}
                </button>
              );
            })}
          </div>

          <button
            type="submit"
            disabled={!canContinue || saving}
            className="w-full py-3 sm:py-4 text-base sm:text-[18px] rounded-lg bg-[#9370DB] text-white font-semibold hover:brightness-95 active:brightness-90 disabled:opacity-60 transition"
          >
            {saving ? "Saving…" : "Continue"}
          </button>

        </form>
      </div>
    </main>
  );
}

function useDebounced<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
