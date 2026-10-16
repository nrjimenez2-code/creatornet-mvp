/** Sales metadata is public. Delivery links and asset references are private. */
export type PostAction = "buy" | "book" | "tip" | null;
export type DeliveryLink = { label: string; url: string };
export type DeliveryVideo = { label: string; asset_id: string };
export type ProductDelivery = { links: DeliveryLink[]; videos: DeliveryVideo[] };
export const PREMIUM_MAX_SECONDS = 10 * 60 * 60;
export const PREMIUM_MAX_BYTES = 30_000_000_000; // strictly below the provider ceiling
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isDeliveryId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function readPostAction(value: unknown): PostAction {
  if (value === null || value === "buy" || value === "book" || value === "tip") return value;
  throw Error("Choose Buy, Book, Tip, or leave the video button unselected.");
}
export function legacyPostAction(post: { product_id?: unknown; offering_id?: unknown; price_cents?: unknown; allow_booking?: unknown; tips_enabled?: unknown }): PostAction {
  if (post.product_id || post.offering_id || Number(post.price_cents || 0) > 0) return "buy";
  if (post.allow_booking) return "book";
  return post.tips_enabled ? "tip" : null;
}
export function deliveryUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
export function readProductDelivery(value: unknown, type: string): ProductDelivery {
  if (!value || typeof value !== "object") throw Error("Add delivery for this product.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.links) || !Array.isArray(input.videos) || input.links.length > 30 || input.videos.length > 100) throw Error("Invalid product delivery.");
  const label = (row: Record<string, unknown>) => {
    if (typeof row.label !== "string" || !row.label.trim() || row.label.trim().length > 160) throw Error("Give each deliverable a title.");
    return row.label.trim();
  };
  const links = input.links.map((item: unknown) => {
    if (!item || typeof item !== "object") throw Error("Invalid access link.");
    const row = item as Record<string, unknown>;
    if (!deliveryUrl(row.url)) throw Error("Access links must use HTTPS without credentials.");
    return { label: label(row), url: row.url.trim() };
  });
  const videos = input.videos.map((item: unknown) => {
    if (!item || typeof item !== "object") throw Error("Invalid video.");
    const row = item as Record<string, unknown>;
    if (!isDeliveryId(row.asset_id)) throw Error("Choose an uploaded private video.");
    return { label: label(row), asset_id: row.asset_id };
  });
  if (new Set(videos.map(v => v.asset_id)).size !== videos.length) throw Error("A video can appear only once in a product.");
  if (type === "video" && (videos.length !== 1 || links.length)) throw Error("A video product includes one private video.");
  if (type === "bundle" && (videos.length < 2 || links.length)) throw Error("A video bundle includes at least two videos.");
  if ((type === "course" || type === "mentorship") && !links.length && !videos.length) throw Error("Add an access link or included video.");
  if (!["video", "bundle", "course", "mentorship"].includes(type)) throw Error("Unsupported digital product type.");
  return { links, videos };
}
export function readPremiumUpload(value: unknown): { size: number; duration: number; fingerprint: string; name: string } {
  if (!value || typeof value !== "object") throw Error("Choose a video.");
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.size) || Number(v.size) <= 0 || Number(v.size) >= PREMIUM_MAX_BYTES) throw Error("Video must be below 30 GB.");
  if (typeof v.duration !== "number" || !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > PREMIUM_MAX_SECONDS) throw Error("Video must be at most 10 hours, with detectable duration.");
  if (typeof v.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.fingerprint)) throw Error("Invalid upload fingerprint.");
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 255) throw Error("Invalid filename.");
  return { size: Number(v.size), duration: v.duration, fingerprint: v.fingerprint, name: v.name.trim() };
}
export function reservedVideoSeconds(duration: number): number {
  return Math.min(PREMIUM_MAX_SECONDS, Math.ceil(duration + Math.max(10, duration * 0.02)));
}
