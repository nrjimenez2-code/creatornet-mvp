// components/PostComposer.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabaseClient";
import { extractHashtags } from "@/lib/hashtags";

/* ------------------------------------------------------------------ */
/* Constants / types                                                  */
/* ------------------------------------------------------------------ */

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

type Props = { onPosted?: () => void };

type Product = {
  id: string;
  title: string;
  type: "video" | "course" | "mentorship";
  price_cents: number | null;
  external_url: string | null;
  active: boolean;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function dollarsToCents(d: string): number | null {
  if (!d?.trim()) return null;
  const n = Number(d);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.round(n * 100));
}

async function createProductViaAPI(input: {
  title: string;
  priceDollars?: string;
  description?: string;
  type?: "video" | "course" | "mentorship";
  creator_id?: string;
}): Promise<Product> {
  const res = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      title: input.title,
      description: input.description ?? "",
      type: input.type ?? "video",
      price_cents: dollarsToCents(input.priceDollars ?? ""),
      creator_id: input.creator_id,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || "Unauthorized");
  }
  return data.product as Product;
}

async function fetchMyProducts(): Promise<Product[]> {
  const res = await fetch("/api/products", {
    method: "GET",
    credentials: "include",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Failed to load products");
  return (data?.items ?? []) as Product[];
}

/** Accept ANY https URL; auto-prefix missing scheme. */
function normalizeBookingUrl(u: string): string | null {
  const raw = (u || "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Large-file aware Storage upload                                    */
/* ------------------------------------------------------------------ */

const SIMPLE_UPLOAD_MAX = 20 * 1024 * 1024; // 20 MB
const UPLOAD_TIMEOUT_MS = 60_000; // guard against “hangs”

async function uploadToBucketPath(
  supabase: ReturnType<typeof createClient>,
  bucket: "videos" | "thumbnails" | "premium",
  file: File,
  userId: string
): Promise<{ publicUrl?: string; path: string }> {
  const ext =
    file.name.split(".").pop() || (bucket === "thumbnails" ? "jpg" : "mp4");
  const path = `${userId}/${Date.now()}.${ext}`;
  const contentType =
    file.type ||
    (bucket === "thumbnails"
      ? "image/jpeg"
      : bucket === "videos"
      ? "video/mp4"
      : "application/octet-stream");

  const doSimple = async () => {
    const { error } = await supabase.storage.from(bucket).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType,
    });
    if (error) throw error;
  };

  const doSigned = async () => {
    const { data: signed, error: signErr } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(path);
    if (signErr) throw signErr;

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .uploadToSignedUrl(signed.path, signed.token, file, { contentType });
    if (upErr) throw upErr;
  };

  const withTimeout = <T,>(p: Promise<T>) =>
    Promise.race<T>([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error("Upload timed out")), UPLOAD_TIMEOUT_MS)
      ),
    ]);

  if (file.size <= SIMPLE_UPLOAD_MAX) {
    await withTimeout(doSimple());
  } else {
    await withTimeout(doSigned());
  }

  if (bucket === "premium") return { path }; // keep private

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export default function PostComposer({ onPosted }: Props) {
  const supabase = createClient();

  const [userId, setUserId] = useState<string | null>(null);

  // Post fields
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [priceDollars, setPriceDollars] = useState<string>("");
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);

  // Product attach
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<string | null>(null);
  const [attachBuy, setAttachBuy] = useState<boolean>(false);

  // Booking (optional)
  const [attachBooking, setAttachBooking] = useState<boolean>(false);
  const [bookingUrl, setBookingUrl] = useState<string>("");

  // Inline product creation
  const [newProdOpen, setNewProdOpen] = useState(false);
  const [newProdTitle, setNewProdTitle] = useState("");
  const [newProdPrice, setNewProdPrice] = useState<string>(""); // dollars
  const [newProdType, setNewProdType] = useState<"video" | "course" | "mentorship">("video");

  // Assets
  const [videoFile, setVideoFile] = useState<File | null>(null); // promo/public
  const [thumbFile, setThumbFile] = useState<File | null>(null); // public
  const [premiumFile, setPremiumFile] = useState<File | null>(null); // private

  // UI state
  const [myTags, setMyTags] = useState<Tag[]>([]);
  const [posting, setPosting] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);

  // Derived: hashtags from caption (kept up to date as you type)
  const hashtags = useMemo(() => extractHashtags(caption), [caption]);

  // Load auth + interests
  useEffect(() => {
    (async () => {
      const [{ data: auth }, { data: prof, error }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from("profiles").select("interests").limit(1),
      ]);

      setUserId(auth.user?.id ?? null);

      const interests =
        !error && Array.isArray(prof?.[0]?.interests)
          ? (prof![0]!.interests as Tag[])
          : [];
      setMyTags(interests.length ? interests : [...FALLBACK_TAGS]);
    })();
  }, [supabase]);

  // Fetch creator products
  useEffect(() => {
    (async () => {
      setLoadingProducts(true);
      try {
        const items = await fetchMyProducts();
        setProducts(items);
      } catch (e) {
        console.debug("products GET:", (e as any)?.message);
      } finally {
        setLoadingProducts(false);
      }
    })();
  }, []);

  const chars = caption.trim().length;

  // valid if: required fields ok AND (booking disabled OR booking blank OR valid https)
  const bookingNormalized = normalizeBookingUrl(bookingUrl);
  const bookingRaw = (bookingUrl || "").trim();
  const canPost = useMemo(
    () =>
      !!userId &&
      !!videoFile &&
      !!selectedTag &&
      chars > 0 &&
      chars <= 300 &&
      (!attachBooking || bookingRaw === "" || !!bookingNormalized),
    [userId, videoFile, selectedTag, chars, attachBooking, bookingRaw, bookingNormalized]
  );

  async function handleCreateProduct() {
    if (creatingProduct) return;

    const t = newProdTitle.trim();
    if (!t) {
      alert("Give your product a title.");
      return;
    }

    setCreatingProduct(true);
    try {
      const newProduct = await createProductViaAPI({
        title: t,
        priceDollars: newProdPrice,
        type: newProdType,
        creator_id: userId ?? undefined,
      });

      setProducts((prev) => [newProduct, ...prev]);
      setProductId(newProduct.id);
      setAttachBuy(true);

      if (!priceDollars && newProduct.price_cents) {
        setPriceDollars(String(newProduct.price_cents / 100));
      }

      setNewProdOpen(false);
      setNewProdTitle("");
      setNewProdPrice("");
      setNewProdType("video");
    } catch (e: any) {
      alert(e?.message || "Failed to create product");
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handlePost() {
    if (!userId || !videoFile || !selectedTag) return;

    // If a non-empty URL is provided but invalid, block and alert.
    if (attachBooking && bookingRaw !== "" && !bookingNormalized) {
      alert("Please enter a valid https booking link (or leave it blank to auto-route).");
      return;
    }

    setPosting(true);

    try {
      // 1) promo video (public)
      const promo = await uploadToBucketPath(supabase, "videos", videoFile, userId);
      const video_url = promo.publicUrl!;

      // 2) optional thumbnail (public)
      let poster_url: string | null = null;
      if (thumbFile) {
        const thumb = await uploadToBucketPath(supabase, "thumbnails", thumbFile, userId);
        poster_url = thumb.publicUrl! ?? null;
      }

      // 3) optional premium file (private)
      let premium_path: string | null = null;
      if (premiumFile) {
        const prem = await uploadToBucketPath(supabase, "premium", premiumFile, userId);
        premium_path = prem.path;
      }

      // 4) decide post price
      const attached = productId ? products.find((p) => p.id === productId) : null;
      const price_cents =
        dollarsToCents(priceDollars) ?? attached?.price_cents ?? null;

      // 5) Compute final booking target
      const finalBookingUrl =
        attachBooking
          ? bookingNormalized || `/api/book?creator_id=${userId}`
          : null;

      // 6) insert post (✅ now includes hashtags)
      const { error: insErr } = await supabase.from("posts").insert([
        {
          creator_id: userId,
          title: title.trim() || null,
          content: caption.trim(),
          video_url,             // public promo
          poster_url,            // optional
          premium_path,          // private storage path if provided
          interests: [selectedTag],
          product_id: attachBuy ? productId : null, // controls CTA
          price_cents,
          allow_booking: attachBooking || null,
          booking_url: finalBookingUrl,
          hashtags,              // ✅ store extracted hashtags (text[])
        },
      ]);
      if (insErr) throw insErr;

      // 7) reset UI
      setTitle("");
      setCaption("");
      setPriceDollars("");
      setVideoFile(null);
      setThumbFile(null);
      setPremiumFile(null);
      setSelectedTag(null);
      setProductId(null);
      setAttachBuy(false);
      setAttachBooking(false);
      setBookingUrl("");

      onPosted?.();
    } catch (err: any) {
      console.error("Create post failed:", err);
      alert(err?.message ?? "Failed to post. Try again.");
    } finally {
      setPosting(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                 */
  /* ------------------------------------------------------------------ */

  return (
    <div className="rounded-xl border border-gray-200 shadow-sm p-4">
      {/* Title */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
      />

      {/* Caption */}
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        maxLength={300}
        placeholder="Share a tip, a lesson, or a quick insight…  (use #tags like #daytrading #smma)"
        className="mt-3 w-full rounded-md border border-gray-300 px-3 py-3 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/25"
        rows={3}
      />

      {/* Price override */}
      <div className="mt-3 flex items-center gap-2">
        <label className="text-sm text-gray-600">$</label>
        <input
          inputMode="decimal"
          value={priceDollars}
          onChange={(e) => setPriceDollars(e.target.value)}
          placeholder="Price (optional, e.g. 25 for $25.00)"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
        />
      </div>

      {/* Product attach */}
      <div className="mt-3">
        <label className="inline-flex items-center gap-2 select-none">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={attachBuy}
            onChange={(e) => setAttachBuy(e.target.checked)}
          />
          <span className="text-sm text-gray-800">Attach “Buy / Book” to this post</span>
        </label>

        {attachBuy && (
          <div className="mt-2 space-y-2">
            <div className="flex gap-2">
              <select
                value={productId ?? ""}
                onChange={(e) => setProductId(e.target.value || null)}
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
                disabled={loadingProducts}
              >
                <option value="">
                  {loadingProducts ? "Loading…" : "Select a product…"}
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.price_cents != null ? ` — $${(p.price_cents / 100).toFixed(0)}` : ""}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setNewProdOpen((v) => !v)}
                className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              >
                {newProdOpen ? "Cancel" : "New"}
              </button>
            </div>

            {newProdOpen && (
              <div className="rounded-lg border p-3 space-y-2">
                <input
                  value={newProdTitle}
                  onChange={(e) => setNewProdTitle(e.target.value)}
                  placeholder="Product title (e.g., 1-Hour Masterclass)"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
                />
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-600 shrink-0">Type</label>
                  <select
                    value={newProdType}
                    onChange={(e) => setNewProdType(e.target.value as "video" | "course" | "mentorship")}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
                  >
                    <option value="video">Video</option>
                    <option value="course">Course</option>
                    <option value="mentorship">Mentorship</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-600 shrink-0">$</label>
                  <input
                    inputMode="decimal"
                    value={newProdPrice}
                    onChange={(e) => setNewProdPrice(e.target.value)}
                    placeholder="Price (optional)"
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
                  />
                  <button
                    type="button"
                    onClick={handleCreateProduct}
                    disabled={creatingProduct}
                    className="rounded-md bg-[#9370DB] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-60"
                  >
                    {creatingProduct ? "Creating…" : "Create"}
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  Dollars are auto-converted to cents and saved on the product.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-500">
              Tip: If you leave the post price empty, we’ll use the attached product’s price.
              You can still override with a custom price above.
            </p>
          </div>
        )}
      </div>

      {/* Booking option */}
      <div className="mt-3">
        <label className="inline-flex items-center gap-2 select-none">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={attachBooking}
            onChange={(e) => setAttachBooking(e.target.checked)}
          />
          <span className="text-sm text-gray-800">
            Offer “Book a free call” on this post
          </span>
        </label>

        {attachBooking && (
          <div className="mt-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Booking URL
            </label>
            <input
              value={bookingUrl}
              onChange={(e) => setBookingUrl(e.target.value)}
              placeholder="https://your-booking-link.com/... (leave blank to auto-route to your team)"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/20"
            />
            <p className="mt-1 text-xs text-gray-500">
              Buyers who choose “Book” go through a $0 Stripe checkout and are then redirected here.
              Any secure (https) link works — Calendly, Cal.com, Google Meet, your closer’s CRM, etc.
              Leave blank to automatically route to your team’s closer.
            </p>
          </div>
        )}
      </div>

      {/* Tags */}
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
        {/* Public promo video */}
        <label className="flex items-center justify-between gap-3 rounded-md border border-gray-300 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
          <span className="truncate">
            {videoFile ? `🎬 ${videoFile.name}` : "🎬 Choose .mp4 video (promo/public)"}
          </span>
          <input
            type="file"
            accept="video/mp4"
            className="hidden"
            onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {/* Public thumbnail */}
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

        {/* Private premium file */}
        <label className="flex items-center justify-between gap-3 rounded-md border border-gray-300 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 sm:col-span-2">
          <span className="truncate">
            {premiumFile ? `🔒 premium: ${premiumFile.name}` : "🔒 Premium .mp4 (private, optional)"}
          </span>
          <input
            type="file"
            accept="video/mp4"
            className="hidden"
            onChange={(e) => setPremiumFile(e.target.files?.[0] ?? null)}
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
