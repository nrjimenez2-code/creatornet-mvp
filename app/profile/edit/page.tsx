"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import { useRequireUser, useUser } from "@/lib/useUser";
import Link from "next/link";
import styles from "./profile-editor.module.css";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import AvatarCropDialog from "@/components/AvatarCropDialog";
import { EditorSkeleton } from "@/components/loading/Skeletons";
import BioMentionEditor from "@/components/BioMentionEditor";
import { validateWebsite } from "@/lib/profileBio";
import { profileWebsiteReady, profileWebsiteColumn, type EditableProfile } from "@/lib/profileWebsiteReady";

export default function EditProfilePage() {
  const router = useRouter();
  const supabase = createBrowserClient();
  const { session } = useUser();
  const { userId, loading } = useRequireUser();

  const [username, setUsername] = useState("");
  const [tagline, setTagline] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [website, setWebsite] = useState("");
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  const websiteInput = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [selectedAvatarUrl, setSelectedAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // If the profile never loaded, saving would overwrite real fields with
  // empties — block the form until a reload succeeds.
  const [loadFailed, setLoadFailed] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = saving || avatarUploading;
  const disabled = busy || loading || !profileLoaded || loadFailed;

  useEffect(() => {
    if (!selectedAvatarUrl) return;
    return () => URL.revokeObjectURL(selectedAvatarUrl);
  }, [selectedAvatarUrl]);

  // Load current profile (signed-out users are redirected by useRequireUser)
  useEffect(() => {
    if (loading || !userId) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select(`username, tagline, avatar_url, bio${profileWebsiteColumn()}`)
        .eq("id", userId)
        .returns<EditableProfile[]>()
        .maybeSingle();

      if (error) {
        console.error("Profile load failed:", error);
        setLoadFailed(true);
        setErr("Couldn't load your profile. Refresh the page before editing — saving now could overwrite your info.");
        return;
      }

      setProfileLoaded(true);
      setLoadFailed(false);
      setUsername(data?.username ?? session?.user?.email?.split("@")[0] ?? "");
      setTagline(data?.tagline ?? "");
      setAvatarUrl(data?.avatar_url ?? "");
      setBio(data?.bio ?? "");
      setWebsite(data?.website_url ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, userId]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    const validatedWebsite = validateWebsite(profileWebsiteReady() ? website : "");
    setWebsiteError(validatedWebsite.error);
    if (validatedWebsite.error) { websiteInput.current?.focus(); return; }
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
      const { error, count } = await supabase
        .from("profiles")
        .update({
          username: trimmedUsername,
          tagline: tagline.trim() === "" ? null : tagline.trim(),
          avatar_url: avatarUrl || null,
          bio: bio.trim() === "" ? null : bio,
          ...(profileWebsiteReady() ? { website_url: validatedWebsite.url } : {}),
        }, { count: "exact" })
        .eq("id", userId);

      if (error) throw error;
      if (count !== 1) throw new Error("Your profile could not be saved. Refresh the page and try again.");

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

  function handleAvatarSelection(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    if (disabled) return;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";

    if (file.size > 5 * 1024 * 1024) {
      setErr("Please choose an image under 5MB.");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setErr("Please choose a JPG, PNG, WebP or GIF image.");
      return;
    }

    setErr(null);
    setMsg(null);
    setSelectedAvatarUrl(URL.createObjectURL(file));
  }

  async function saveCroppedAvatar(croppedPhoto: Blob) {
    setAvatarUploading(true);
    setErr(null);
    setMsg(null);

    try {
      if (!userId) throw new Error("No user");

      const filePath = `${userId}/avatar-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;

      const { error: uploadErr } = await supabase.storage
        .from("avatars")
        .upload(filePath, croppedPhoto, {
          cacheControl: "3600",
          upsert: false,
          contentType: "image/png",
        });

      if (uploadErr) {
        throw uploadErr;
      }

      const { data } = supabase.storage.from("avatars").getPublicUrl(filePath);
      const publicUrl = data.publicUrl;


      const { error: profileErr } = await supabase
        .from("profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", userId);

      if (profileErr) throw profileErr;
      setAvatarUrl(publicUrl);
      setSelectedAvatarUrl(null);

      setMsg("Avatar updated. Your profile photo is live.");
      router.refresh();
    } catch (error: any) {
      setErr(
        error?.message ??
          "Couldn't upload your photo. Please try again."
      );
    } finally {
      setAvatarUploading(false);
    }
  }

  if (!profileLoaded && !loadFailed) return <EditorSkeleton />;

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="edit-profile-title">
        <Link href="/profile" className={styles.back}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Profile
        </Link>
        <header className={styles.header}>
          <h1 id="edit-profile-title">Edit profile</h1>
          <p>A little about you.</p>
        </header>
        <form onSubmit={onSubmit} aria-busy={busy}>
          <div className={styles.photoRow}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.avatar} src={avatarUrl || DEFAULT_AVATAR_URL} alt="Profile photo" width={72} height={72} />
            <div className={styles.photoCopy}>
              <h2>Profile photo</h2>
              <p id="photo-help">JPG, PNG, WebP or GIF · Up to 5 MB</p>
            </div>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleAvatarSelection} disabled={disabled} hidden aria-label="Choose profile photo" />
            <button type="button" className={styles.changePhoto} disabled={disabled} onClick={() => fileInput.current?.click()} aria-describedby="photo-help">
              {avatarUploading ? "Uploading…" : "Change photo"}
            </button>
          </div>
          <fieldset className={styles.fields} disabled={disabled}>
            <div className={styles.field}>
              <label htmlFor="profile-username">Username</label>
              <div className={styles.usernameInput}>
                <span aria-hidden="true">@</span>
                <input id="profile-username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" aria-describedby="username-help" required />
              </div>
              <p id="username-help" className={styles.hint}>Your unique name on CreatorNet.</p>
            </div>
            <div className={styles.field}>
              <label htmlFor="profile-bio">Bio</label>
              <BioMentionEditor value={bio} onChange={setBio} disabled={disabled} />
              <p id="bio-count" className={styles.count}>{bio.length} / 600</p>
            </div>
            {profileWebsiteReady() ? <div className={styles.field}>
              <label htmlFor="profile-website">Website</label>
              <input ref={websiteInput} id="profile-website" name="website" type="text" inputMode="url" autoComplete="url"
                value={website} maxLength={2048} aria-invalid={!!websiteError} aria-describedby={websiteError ? "website-help website-error" : "website-help"}
                onChange={event => { setWebsite(event.target.value); if (websiteError) setWebsiteError(validateWebsite(event.target.value).error); }} />
              <p id="website-help" className={styles.hint}>Optional · Add your website or a link.</p>
              {websiteError ? <p id="website-error" role="alert" className={styles.error}>{websiteError}</p> : null}
            </div> : null}
          </fieldset>
          {!profileLoaded && !loadFailed ? <p role="status" className={styles.hint}>Loading your profile…</p> : null}
          {err ? <p role="alert" className={styles.error}>{err}</p> : null}
          {msg ? <p role="status" className={styles.success}>{msg}</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.cancel} disabled={busy} onClick={() => { router.replace("/profile"); router.refresh(); }}>Cancel</button>
            <button type="submit" disabled={disabled} className={styles.save}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
        {selectedAvatarUrl && (
          <AvatarCropDialog
            photoUrl={selectedAvatarUrl}
            uploading={avatarUploading}
            uploadError={err}
            onCancel={() => { setSelectedAvatarUrl(null); setErr(null); }}
            onSave={saveCroppedAvatar}
          />
        )}
      </section>
    </main>
  );
}
