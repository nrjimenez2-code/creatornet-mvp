"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import BackButton from "@/components/BackButton";

export default function EditProfilePage() {
  const router = useRouter();
  const supabase = createBrowserClient();

  const [username, setUsername] = useState("");
  const [tagline, setTagline] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUploading, setAvatarUploading] = useState(false);
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
        .select("username, tagline, avatar_url, bio")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(data?.username ?? user.email?.split("@")[0] ?? "");
      setTagline(data?.tagline ?? "");
      setAvatarUrl(data?.avatar_url ?? "");
      setBio(data?.bio ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
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

      const trimmedUsername = username.trim();
      if (!trimmedUsername) {
        setErr("Username is required.");
        setSaving(false);
        return;
      }

      // Upsert with explicit id; conflict on 'id'
      const { error } = await supabase
        .from("profiles")
        .upsert(
          {
            id: user.id,
            username: trimmedUsername,
            tagline: tagline.trim() === "" ? null : tagline.trim(),
            avatar_url: avatarUrl || null,
            bio: bio.trim() === "" ? null : bio.trim(),
          },
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

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setErr("Please choose an image under 5MB.");
      e.target.value = "";
      return;
    }

    setAvatarUploading(true);
    setErr(null);
    setMsg(null);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr || !user) throw userErr || new Error("No user");

      const ext = file.name.split(".").pop() || "png";
      const filePath = `${user.id}/avatar-${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: true,
          contentType: file.type || "image/png",
        });

      if (uploadErr) {
        throw uploadErr;
      }

      const { data } = supabase.storage.from("avatars").getPublicUrl(filePath);
      const publicUrl = data.publicUrl;
      setAvatarUrl(publicUrl);

      const { error: profileErr } = await supabase
        .from("profiles")
        .upsert(
          {
            id: user.id,
            avatar_url: publicUrl,
          },
          { onConflict: "id" }
        );

      if (profileErr) throw profileErr;

      setMsg("Avatar updated. Your profile photo is live.");
      router.refresh();
    } catch (error: any) {
      setErr(
        error?.message ??
          "Failed to upload avatar. Make sure the 'avatars' bucket exists and is public."
      );
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  }

  return (
    <section className="max-w-2xl px-6 pb-16 pt-8">
      <BackButton />
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
            suppressHydrationWarning
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
            suppressHydrationWarning
          />
          <p className="mt-1 text-xs text-gray-500">{tagline.length}/160</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
            rows={4}
            maxLength={600}
            suppressHydrationWarning
          />
          <p className="mt-1 text-xs text-gray-500">{bio.length}/600</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Profile photo</label>
          {avatarUrl ? (
            <div className="mb-3 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl}
                alt="Avatar preview"
                className="h-20 w-20 rounded-full object-cover border border-gray-200"
              />
              <span className="text-xs text-gray-500">Current preview</span>
            </div>
          ) : (
            <p className="mb-3 text-xs text-gray-500">
              No photo yet. Upload one or paste an image URL below.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <input
              type="file"
              accept="image/*"
              onChange={handleAvatarUpload}
              disabled={avatarUploading}
              className="text-xs"
            />
            {avatarUploading ? (
              <span className="text-xs text-gray-500">Uploading…</span>
            ) : (
              <span className="text-xs text-gray-500">
                JPG, PNG, or GIF up to 5MB.
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Uploads go to the public <span className="font-medium">avatars</span>{" "}
            storage bucket. Remember to save changes after uploading.
          </p>
          <label className="mt-3 block text-xs font-semibold uppercase text-gray-500">
            Or paste an image URL
          </label>
          <input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
            inputMode="url"
            placeholder="https://…"
            suppressHydrationWarning
          />
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-[#7F5CE6] px-4 py-2 text-white font-medium disabled:opacity-60"
            suppressHydrationWarning
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
            suppressHydrationWarning
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
