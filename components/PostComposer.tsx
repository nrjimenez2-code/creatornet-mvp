"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// If you already render these elsewhere, feel free to remove
const FALLBACK_TAGS = [
  "Entrepreneurship",
  "Money & Investing",
  "Social Media Growth",
  "Content Creation",
  "Online Skills",
  "Health & Fitness",
  "Self Improvement",
  "Tech & AI Automation",
] as const;
type Tag = (typeof FALLBACK_TAGS)[number];

type Props = {
  onPosted?: () => void;
};

export default function PostComposer({ onPosted }: Props) {
  const [userId, setUserId] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [myTags, setMyTags] = useState<Tag[]>([]);
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);
  const [posting, setPosting] = useState(false);
  const chars = caption.trim().length;

  // Load auth + (optionally) the user's interests to pre-fill tags
  useEffect(() => {
    (async () => {
      const [{ data: auth }, { data: prof }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from("profiles").select("interests").limit(1),
      ]);
      setUserId(auth.user?.id ?? null);

      const interests = Array.isArray(prof?.[0]?.interests)
        ? (prof![0]!.interests as Tag[])
        : [];
      setMyTags(interests.length ? interests : [...FALLBACK_TAGS]);
    })();
  }, []);

  const canPost = useMemo(
    () => !!userId && !!videoFile && !!selectedTag && chars > 0 && chars <= 300,
    [userId, videoFile, selectedTag, chars]
  );

  async function uploadToBucket(
    bucket: "videos" | "thumbnails",
    file: File,
    userId: string
  ) {
    const ext = file.name.split(".").pop() || (bucket === "videos" ? "mp4" : "jpg");
    const path = `${userId}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || (bucket === "videos" ? "video/mp4" : "image/jpeg"),
    });
    if (upErr) throw upErr;

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  async function handlePost() {
    if (!userId || !videoFile || !selectedTag) return;
    setPosting(true);

    try {
      // 1) Upload video
      const video_url = await uploadToBucket("videos", videoFile, userId);

      // 2) Upload optional thumbnail
      let poster_url: string | null = null;
      if (thumbFile) {
        poster_url = await uploadToBucket("thumbnails", thumbFile, userId);
      }

      // 3) Insert post
      const { error: insErr } = await supabase.from("posts").insert({
        user_id: userId,
        caption: caption.trim(),
        video_url,
        poster_url,
        tags: [selectedTag], // keep simple: one tag per post for now
      });

      if (insErr) throw insErr;

      // 4) Reset UI
      setCaption("");
      setVideoFile(null);
      setThumbFile(null);
      setSelectedTag(null);

      onPosted?.();
    } catch (err: any) {
      alert(err?.message ?? "Failed to post. Try again.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 shadow-sm p-4">
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        maxLength={300}
        placeholder="Share a tip, a lesson, or a quick insight…"
        className="w-full rounded-md border border-gray-300 px-3 py-3 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/25"
        rows={3}
      />

      {/* Tags / Interests */}
      <div className="flex flex-wrap gap-2 mt-3">
        {myTags.map((t) => {
          const active = t === selectedTag;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setSelectedTag((prev) => (prev === t ? null : t))}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${
                active
                  ? "bg-[#7E5CE6] text-white border-[#7E5CE6]"
                  : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>

      {/* Uploaders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <label className="flex items-center justify-between gap-3 rounded-md border border-gray-300 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
          <span className="truncate">
            {videoFile ? `🎬 ${videoFile.name}` : "🎬 Choose .mp4 video"}
          </span>
          <input
            type="file"
            accept="video/mp4"
            className="hidden"
            onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <label className="flex items-center justify-between gap-3 rounded-md border border-gray-300 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
          <span className="truncate">
            {thumbFile ? `🖼️ ${thumbFile.name}` : "🖼️ Optional thumbnail (.jpg/.png)"}
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => setThumbFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-gray-500">{chars} / 300</span>
        <button
          onClick={handlePost}
          disabled={!canPost || posting}
          className="px-4 py-2 rounded-md bg-[#9370DB] text-white text-sm font-semibold hover:brightness-95 disabled:opacity-60"
        >
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}
