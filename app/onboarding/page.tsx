"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

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

  const [userId, setUserId] = useState<string | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [username, setUsername] = useState("");
  const [usernameOk, setUsernameOk] = useState<boolean | null>(null);
  const [usernameErr, setUsernameErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Interest[]>([]);
  const [saving, setSaving] = useState(false);

  // Load user
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setUserId(data.user?.id ?? null);
      setLoadingUser(false);
    })();
  }, []);

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
  }, [debounced, userId]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const lower = username.trim().toLowerCase();
    setSaving(true);

    const { error } = await supabase
      .from("profiles")
      .update({ username: lower, interests: selected })
      .eq("id", userId);

    if (error) {
      console.error(error);
      setUsernameErr(error.message);
      setSaving(false);
      return;
    }

    router.replace("/dashboard");
  }

  const canContinue =
    !!userId &&
    username.trim().length >= 3 &&
    (usernameOk === true || usernameOk === null);

  const helperText = useMemo(() => {
    if (usernameErr) return usernameErr;
    if (usernameOk === true) return "✅ Username available";
    if (usernameOk === false) return "❌ Username unavailable";
    return "";
  }, [usernameErr, usernameOk]);

  return (
    <main className="min-h-screen bg-white flex items-center justify-center">
      {/* container */}
      <div className="w-[420px]">
        {/* ✅ Title moved further left */}
        <h1 className="text-[32px] font-extrabold text-[#7E5CE6] tracking-wide uppercase whitespace-nowrap text-left -ml-4">
          CHOOSE YOUR INTERESTS
        </h1>

        <p className="text-gray-800 text-sm mt-3 text-left -ml-4">
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
              className={`mt-1 w-full rounded-md border px-3 py-2 text-gray-900 focus:ring-4
                ${
                  usernameOk === false
                    ? "border-red-400 focus:ring-red-200"
                    : "border-gray-300 focus:ring-[#9370DB]/30"
                }`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
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
                  className={`rounded-md border px-4 py-3 text-sm font-medium transition ${
                    active
                      ? "bg-[#7E5CE6] text-white border-[#7E5CE6]"
                      : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {/* ✅ Bottom button now says "Continue" */}
          <button
            type="submit"
            disabled={!canContinue || saving}
            className="w-full py-4 text-[18px] rounded-lg bg-[#9370DB] text-white font-semibold hover:brightness-95 active:brightness-90 disabled:opacity-60 transition whitespace-nowrap"
          >
            {saving ? "Saving…" : "Continue"}
          </button>

          <p
            onClick={() => router.replace("/dashboard")}
            className="text-sm text-gray-600 underline cursor-pointer text-center"
          >
            Skip for now
          </p>
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
