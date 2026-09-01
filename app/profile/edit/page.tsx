"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import { useRequireUser, useUser } from "@/lib/useUser";
import BackButton from "@/components/BackButton";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

export default function EditProfilePage() {
  const router = useRouter();
  const supabase = createBrowserClient();
  const { session } = useUser();
  const { userId, loading } = useRequireUser();

  const [username, setUsername] = useState("");
  const [tagline, setTagline] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // If the profile never loaded, saving would overwrite real fields with
  // empties — block the form until a reload succeeds.
  const [loadFailed, setLoadFailed] = useState(false);

  // Load current profile (signed-out users are redirected by useRequireUser)
  useEffect(() => {
    if (loading || !userId) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("username, tagline, avatar_url, bio")
        .eq("id", userId)
        .maybeSingle();

      if (error) {
        console.error("Profile load failed:", error);
        setLoadFailed(true);
        setErr("Couldn't load your profile. Refresh the page before editing — saving now could overwrite your info.");
        return;
      }

      setLoadFailed(false);
      setUsername(data?.username ?? session?.user?.email?.split("@")[0] ?? "");
      setTagline(data?.tagline ?? "");
      setAvatarUrl(data?.avatar_url ?? "");
      setBio(data?.bio ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, userId]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loadFailed) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      if (!userId) throw new Error("No user");

      const trimmedUsername = username.trim();
      if (!trimmedUsername) {
        setErr("Username is required.");
        setSaving(false);
        return;
      }

      // NEVER .upsert() on public.profiles from the browser client.
      //
      // PostgREST compiles .upsert() to
      //   INSERT ... ON CONFLICT ("id") DO UPDATE SET "id" = EXCLUDED."id", ...
      // and migration 009 grants `authenticated` INSERT on `id` but NOT UPDATE.
      // Every user who already has a profile row takes the DO UPDATE branch, so
      // the save failed with 42501 permission denied — profile editing was
      // broken for every existing user. This is the same bug that broke
      // onboarding and was fixed in #108; that fix did not reach this page.
      //
      // A plain UPDATE touches only columns `authenticated` can write. The row
      // always exists here: the page is only reachable for a signed-in user,
      // and onboarding creates the row.
      const { error } = await supabase
        .from("profiles")
        .update({
          username: trimmedUsername,
          tagline: tagline.trim() === "" ? null : tagline.trim(),
          avatar_url: avatarUrl || null,
          bio: bio.trim() === "" ? null : bio.trim(),
        })
        .eq("id", userId);

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
      if (!userId) throw new Error("No user");

      const ext = file.name.split(".").pop() || "png";
      const filePath = `${userId}/avatar-${Date.now()}.${ext}`;

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
            id: userId,
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
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#4A35C7]"
            inputMode="text"
            autoComplete="off"
            suppressHydrationWarning
          />
          <p className="mt-1 text-xs text-gray-500">Looks good ✓</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#4A35C7]"
            rows={4}
            maxLength={600}
            suppressHydrationWarning
          />
          <p className="mt-1 text-xs text-gray-500">{bio.length}/600</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Profile photo</label>
          <div className="mb-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl || DEFAULT_AVATAR_URL}
              alt="Avatar preview"
              className="h-20 w-20 rounded-full object-cover border border-gray-200"
            />
            <span className="text-xs text-gray-500">
              {avatarUrl ? "Current preview" : "Default photo. Upload or paste URL to change."}
            </span>
          </div>
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
            className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-[#4A35C7]"
            inputMode="url"
            placeholder="https://…"
            suppressHydrationWarning
          />
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving || loadFailed}
            className="rounded-xl bg-[#4A35C7] px-4 py-2 text-white font-medium disabled:opacity-60"
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
