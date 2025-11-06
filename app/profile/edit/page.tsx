"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";

export default function EditProfilePage() {
  const router = useRouter();
  const supabase = createBrowserClient();

  const [username, setUsername] = useState("");
  const [tagline, setTagline] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load current profile
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/auth");
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("username, tagline, avatar_url")
        .eq("id", user.id)
        .single();

      setUsername(data?.username ?? user.email?.split("@")[0] ?? "");
      setTagline(data?.tagline ?? "");
      setAvatarUrl(data?.avatar_url ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr || !user) throw userErr || new Error("No user");

      // Upsert with explicit id; conflict on 'id'
      const { error } = await supabase
        .from("profiles")
        .upsert(
          { id: user.id, username, tagline, avatar_url: avatarUrl },
          { onConflict: "id" }
        );

      if (error) throw error;

      setMsg("Profile updated.");
      // Navigate back and force the RSC to refetch fresh data
      router.replace("/profile");
      router.refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-2xl px-6 pb-16 pt-8">
      <h1 className="text-2xl font-semibold mb-6">Edit Profile</h1>

      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium mb-1">Username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
            inputMode="text"
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-500">Looks good ✓</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Tagline</label>
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
            inputMode="text"
            maxLength={160}
          />
          <p className="mt-1 text-xs text-gray-500">{tagline.length}/160</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Avatar URL</label>
          <input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
            inputMode="url"
            placeholder="https://…"
          />
          <p className="mt-1 text-xs text-gray-500">
            Paste a direct image URL (uploads coming later).
          </p>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-[#7F5CE6] px-4 py-2 text-white font-medium disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => {
              router.replace("/profile");
              router.refresh();
            }}
            className="rounded-xl bg-gray-100 px-4 py-2 font-medium hover:bg-gray-200"
          >
            Cancel
          </button>
        </div>

        {err ? <p className="text-sm text-red-600">{err}</p> : null}
        {msg ? <p className="text-sm text-green-600">{msg}</p> : null}
      </form>
    </section>
  );
}
