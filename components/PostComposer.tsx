// components/PostComposer.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
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
  const raw = (data?.items ?? []) as (Product & { product_id?: string })[];
  return raw.map((p) => ({ ...p, id: p.id ?? p.product_id }));
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
/* R2 upload — public files (videos + thumbnails)                    */
/* ------------------------------------------------------------------ */

type UploadProgressCb = (loaded: number, total: number) => void;

// Abort an upload only after this long with ZERO progress — not a flat wall-clock
// cap, since a large file on a slow connection legitimately takes minutes.
const UPLOAD_STALL_TIMEOUT_MS = 30_000;
const UPLOAD_MAX_ATTEMPTS = 3;

async function generateVideoThumbnail(videoFile: File): Promise<File | null> {
  const objectUrl = URL.createObjectURL(videoFile);

  try {
    const video = document.createElement("video");
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        const targetTime = Math.min(0.2, Math.max(0, (video.duration || 0) / 4));
        if (!Number.isFinite(targetTime)) {
          resolve();
          return;
        }
        video.currentTime = targetTime;
      };
      const onSeeked = () => resolve();
      const onError = () =>
        reject(new Error("Could not load video to generate thumbnail"));

      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
    });

    const width = Math.max(1, video.videoWidth || 720);
    const height = Math.max(1, video.videoHeight || 1280);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.86)
    );
    if (!blob) return null;

    const baseName = videoFile.name.replace(/\.[^/.]+$/, "") || "thumbnail";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * PUT a file to a presigned URL via XHR so we can (a) report real upload
 * progress, (b) check the HTTP status and fail on a non-2xx response — plain
 * fetch treats a 403/5xx as success, which silently saved dead URLs — and
 * (c) abort on a genuine stall rather than a flat wall-clock cap.
 */
function putFileWithProgress(
  uploadUrl: string,
  file: File,
  onProgress?: UploadProgressCb
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (err) reject(err);
      else resolve();
    };

    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true; // claim the result before abort() fires onabort
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        reject(
          new Error("Upload stalled — no progress. Check your connection and try again.")
        );
      }, UPLOAD_STALL_TIMEOUT_MS);
    };

    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      armStall(); // real progress → restart the stall clock
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? settle()
        : settle(new Error(`Storage rejected the upload (HTTP ${xhr.status}).`));
    xhr.onerror = () => settle(new Error("Network error during upload."));
    xhr.onabort = () => settle(new Error("Upload aborted."));

    armStall();
    xhr.send(file);
  });
}

async function uploadToR2(
  file: File,
  folder: "videos" | "thumbnails",
  onProgress?: UploadProgressCb
): Promise<string> {
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    // Fresh presign per attempt — presigned URLs are short-lived.
    const res = await fetch("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || (folder === "thumbnails" ? "image/jpeg" : "video/mp4"),
        folder,
      }),
    });

    if (!res.ok) {
      // Auth/validation failures won't fix themselves on retry — surface now.
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string })?.error ?? "Failed to get upload URL");
    }

    const { uploadUrl, publicUrl } = (await res.json()) as {
      uploadUrl: string;
      publicUrl: string;
    };

    try {
      await putFileWithProgress(uploadUrl, file, onProgress);
      return publicUrl;
    } catch (e) {
      lastErr = e;
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        // Linear backoff, then re-presign and retry.
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Upload failed after multiple attempts.");
}

/* ------------------------------------------------------------------ */
/* Supabase upload — private premium files only                      */
/* ------------------------------------------------------------------ */

const SIMPLE_UPLOAD_MAX = 20 * 1024 * 1024;

async function uploadPremiumToSupabase(
  supabase: ReturnType<typeof createClient>,
  file: File,
  userId: string
): Promise<string> {
  const ext = file.name.split(".").pop() ?? "mp4";
  const path = `${userId}/${Date.now()}.${ext}`;
  const contentType = file.type || "video/mp4";

  if (file.size <= SIMPLE_UPLOAD_MAX) {
    const { error } = await supabase.storage
      .from("premium")
      .upload(path, file, { cacheControl: "3600", upsert: false, contentType });
    if (error) throw error;
  } else {
    const { data: signed, error: signErr } = await supabase.storage
      .from("premium")
      .createSignedUploadUrl(path);
    if (signErr) throw signErr;
    const { error: upErr } = await supabase.storage
      .from("premium")
      .uploadToSignedUrl(signed.path, signed.token, file, { contentType });
    if (upErr) throw upErr;
  }

  return path;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export default function PostComposer({ onPosted }: Props) {
  const supabase = createClient();

  const { userId } = useUser();

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
  const [postError, setPostError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadStage, setUploadStage] = useState<string>("");
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [stripeSellReady, setStripeSellReady] = useState<boolean | null>(null);

  // Derived: hashtags from caption (kept up to date as you type)
  const hashtags = useMemo(() => extractHashtags(caption), [caption]);

  // Load interests (identity comes from the useUser context)
  useEffect(() => {
    (async () => {
      const { data: prof, error } = await supabase
        .from("profiles")
        .select("interests")
        .limit(1);

      const interests =
        !error && Array.isArray(prof?.[0]?.interests)
          ? (prof![0]!.interests as Tag[])
          : [];
      setMyTags(interests.length ? interests : [...FALLBACK_TAGS]);
    })();
  }, [supabase]);

  // Fetch creator products once user is available (session ready)
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoadingProducts(true);
    (async () => {
      try {
        const items = await fetchMyProducts();
        if (!cancelled) setProducts(items);
      } catch (e) {
        if (!cancelled) console.debug("products GET:", (e as { message?: string })?.message);
      } finally {
        if (!cancelled) setLoadingProducts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/stripe/connect/status");
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setStripeSellReady(!!data?.onboarding_complete);
      } catch {
        if (!cancelled) setStripeSellReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (stripeSellReady === false) {
      setAttachBuy(false);
      setProductId(null);
      setNewProdOpen(false);
      setPriceDollars("");
    }
  }, [stripeSellReady]);

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
    } catch (e: unknown) {
      alert((e as { message?: string })?.message || "Failed to create product");
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handlePost() {
    if (!userId || !videoFile || !selectedTag) return;

    // If a non-empty URL is provided but invalid, block with an inline error.
    if (attachBooking && bookingRaw !== "" && !bookingNormalized) {
      setPostError("Please enter a valid https booking link (or leave it blank to auto-route).");
      return;
    }

    setPostError(null);
    setPosting(true);

    try {
      // 1) promo video → R2 (zero egress)
      setUploadStage("Uploading video");
      setUploadPct(0);
      const video_url = await uploadToR2(videoFile, "videos", (loaded, total) =>
        setUploadPct(Math.round((loaded / total) * 100))
      );

      // 2) optional thumbnail → R2 (auto-generate one from video when missing)
      let poster_url: string | null = null;
      const thumbnailSource =
        thumbFile ?? (videoFile ? await generateVideoThumbnail(videoFile) : null);
      if (thumbnailSource) {
        setUploadStage("Uploading thumbnail");
        setUploadPct(0);
        poster_url = await uploadToR2(thumbnailSource, "thumbnails", (loaded, total) =>
          setUploadPct(Math.round((loaded / total) * 100))
        );
      }

      // 3) optional premium file → Supabase (stays private)
      let premium_path: string | null = null;
      if (premiumFile) {
        setUploadStage("Uploading premium file");
        setUploadPct(null); // Supabase path has no granular progress
        premium_path = await uploadPremiumToSupabase(supabase, premiumFile, userId);
      }

      // 4) decide post price and ensure product_id is a UUID (never the option label)
      const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const validProductId = productId && uuidLike.test(String(productId)) ? productId : null;
      const attached = validProductId ? products.find((p) => p.id === validProductId) : null;
      const price_cents =
        dollarsToCents(priceDollars) ?? attached?.price_cents ?? null;

      // 4b) Send selected product id when user chose one; API will verify it exists and belongs to user
      const postProductId = attachBuy && validProductId ? validProductId : null;

      // 5) Compute final booking target
      const finalBookingUrl =
        attachBooking
          ? bookingNormalized || `/api/book?creator_id=${userId}`
          : null;

      // 6) create post via API (server verifies product_id and inserts with admin client to satisfy posts_product_fk)
      setUploadStage("Publishing");
      setUploadPct(null);
      const postRes = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          title: title.trim() || null,
          content: caption.trim(),
          video_url,
          poster_url,
          premium_path,
          interests: [selectedTag],
          product_id: postProductId,
          price_cents,
          allow_booking: !!attachBooking,
          booking_url: finalBookingUrl,
          hashtags,
        }),
      });
      const postData = await postRes.json().catch(() => null);
      if (!postRes.ok || !postData?.success) {
        const msg =
          postData?.code === "STRIPE_CONNECT_REQUIRED"
            ? "Connect Stripe on the dashboard to sell products or set a price."
            : postData?.error ?? "Failed to create post";
        throw new Error(msg);
      }
      if (postData?.warning) {
        alert(postData.warning);
      }

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
    } catch (err: unknown) {
      console.error("Create post failed:", err);
      const base =
        (err as { message?: string })?.message ?? "Failed to post. Try again.";
      // Name the stage that failed; the picked files are intentionally NOT cleared
      // here (the reset only runs on success), so the user can just hit Post again.
      setPostError(uploadStage ? `${uploadStage} failed: ${base}` : base);
    } finally {
      setPosting(false);
      setUploadPct(null);
      setUploadStage("");
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                 */
  /* ------------------------------------------------------------------ */

  return (
    <div className="rounded-2xl border border-white/10 bg-[#050505] p-5 text-white">
      {/* Title */}
      <div className="space-y-1.5">
        <label className="text-sm font-semibold text-white/80">
          Title (optional)
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What are you sharing?"
          className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
        />
      </div>

      {/* Caption */}
      <div className="mt-4 space-y-1.5">
        <label className="text-sm font-semibold text-white/80">
          Caption / Description
        </label>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          maxLength={300}
          placeholder="Share a tip, a lesson, or a quick insight…  (use #tags like #daytrading #smma)"
          className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-3 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
          rows={3}
        />
      </div>

      {/* Price override */}
      <div className="mt-4 space-y-1.5">
        <label className="text-sm font-semibold text-white/80">
          Price (USD)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-white/60">$</span>
          <input
            inputMode="decimal"
            value={priceDollars}
            onChange={(e) => setPriceDollars(e.target.value)}
            placeholder="Optional, e.g. 25 for $25"
            disabled={stripeSellReady === false}
            className="flex-1 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80 disabled:opacity-50"
          />
        </div>
        {stripeSellReady === false && (
          <p className="text-xs text-amber-200/90">
            Set a price after you connect Stripe (dashboard sidebar).
          </p>
        )}
      </div>

      {/* Product attach */}
      <div className="mt-4 space-y-2">
        <label className="inline-flex items-center gap-2 select-none text-sm text-white/90">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-white/40 bg-transparent text-white focus:ring-white"
            checked={attachBuy}
            disabled={stripeSellReady === false}
            onChange={(e) => setAttachBuy(e.target.checked)}
          />
          Attach &quot;Buy / Book&quot; to this post
        </label>
        {stripeSellReady === false && (
          <p className="text-xs text-amber-200/90">
            Connect Stripe on the dashboard to attach products.
          </p>
        )}

        {attachBuy && stripeSellReady !== false && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="flex gap-2">
              <select
                value={productId ?? ""}
                onChange={(e) => setProductId(e.target.value || null)}
                className="flex-1 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
                disabled={loadingProducts}
              >
                {[
                  <option key="__placeholder" className="bg-black text-white" value="">
                    {loadingProducts ? "Loading…" : "Select a product…"}
                  </option>,
                  ...products
                    .filter((p) => p.id)
                    .map((p) => (
                      <option key={p.id} className="bg-black text-white" value={String(p.id)}>
                        {p.title}
                        {p.price_cents != null ? ` — $${(p.price_cents / 100).toFixed(0)}` : ""}
                      </option>
                    )),
                ]}
              </select>

              <button
                type="button"
                onClick={() => setNewProdOpen((v) => !v)}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white hover:bg-white/10"
              >
                {newProdOpen ? "Cancel" : "New"}
              </button>
            </div>

            {newProdOpen && (
              <div className="space-y-2 rounded-xl border border-white/10 bg-black/40 p-3">
                <input
                  value={newProdTitle}
                  onChange={(e) => setNewProdTitle(e.target.value)}
                  placeholder="Product title (e.g., 1-Hour Masterclass)"
                  className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
                />
                <div className="flex items-center gap-2">
                  <label className="text-sm text-white/60 shrink-0">Type</label>
                  <select
                    value={newProdType}
                    onChange={(e) => setNewProdType(e.target.value as "video" | "course" | "mentorship")}
                    className="flex-1 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
                  >
                    {[
                      <option key="video" className="bg-black text-white" value="video">Video</option>,
                      <option key="course" className="bg-black text-white" value="course">Course</option>,
                      <option key="mentorship" className="bg-black text-white" value="mentorship">Mentorship</option>,
                    ]}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-white/60 shrink-0">$</label>
                  <input
                    inputMode="decimal"
                    value={newProdPrice}
                    onChange={(e) => setNewProdPrice(e.target.value)}
                    placeholder="Price (optional)"
                    className="flex-1 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
                  />
                  <button
                    type="button"
                    onClick={handleCreateProduct}
                    disabled={creatingProduct}
                    className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-60"
                  >
                    {creatingProduct ? "Creating…" : "Create"}
                  </button>
                </div>
                <p className="text-xs text-white/50">
                  Dollars are auto-converted to cents and saved on the product.
                </p>
              </div>
            )}

            <p className="text-xs text-white/50">
              Tip: leave the post price blank to reuse the attached product price. You can still override above.
            </p>
          </div>
        )}
      </div>

      {/* Booking option */}
      <div className="mt-4 space-y-2">
        <label className="inline-flex items-center gap-2 select-none text-sm text-white/90">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-white/40 bg-transparent text-white focus:ring-white"
            checked={attachBooking}
            onChange={(e) => setAttachBooking(e.target.checked)}
          />
          Offer &quot;Book a free call&quot; on this post
        </label>

        {attachBooking && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
            <label className="text-sm font-semibold text-white/80">Booking URL</label>
            <input
              value={bookingUrl}
              onChange={(e) => setBookingUrl(e.target.value)}
              placeholder="https://your-booking-link.com (leave blank to auto-route)"
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/80"
            />
            <p className="text-xs text-white/50">
              Buyers who pick &quot;Book&quot; go through a $0 checkout, then get redirected here. Use any https link
              (Calendly, Cal.com, CRM, etc.).
            </p>
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="mt-4 flex flex-wrap gap-2">
        {myTags.map((t) => {
          const active = t === selectedTag;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setSelectedTag((prev) => (prev === t ? null : t))}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${
                active
                  ? "bg-[#4A35C7] text-white border-[#4A35C7]"
                  : "bg-black/40 text-white border-white/20 hover:bg-black/60"
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>

      {/* Uploaders */}
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm cursor-pointer hover:bg-black/60">
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

        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm cursor-pointer hover:bg-black/60">
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

        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm cursor-pointer hover:bg-black/60 sm:col-span-2">
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

      {/* Upload progress */}
      {posting && uploadPct !== null && (
        <div className="mt-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-white/60">
            <span>{uploadStage || "Uploading"}…</span>
            <span>{uploadPct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[#4A35C7] transition-[width] duration-150"
              style={{ width: `${uploadPct}%` }}
            />
          </div>
        </div>
      )}

      {postError && !posting && (
        <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
          {postError}
        </p>
      )}

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-xs text-white/50">{chars} / 300</span>
        <button
          onClick={handlePost}
          disabled={!canPost || posting}
          className="rounded-full bg-[#4A35C7] px-5 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
        >
          {posting
            ? uploadPct !== null
              ? `${uploadStage || "Uploading"}… ${uploadPct}%`
              : `${uploadStage || "Posting"}…`
            : "Post"}
        </button>
      </div>
    </div>
  );
}
