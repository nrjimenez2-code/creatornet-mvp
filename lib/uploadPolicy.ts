// lib/uploadPolicy.ts — what may be uploaded to the public R2 bucket.
//
// The bucket is served from a public CDN origin. Before this, the presign
// route accepted any content type, so a signed-in user could upload
// text/html (a phishing page on our domain) or a 50 GB file (our bill).
// The composer sends file.type, which for real videos and images is one of
// the types below, so honest uploads are unaffected.

export const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
  "video/mpeg",
  "video/3gpp",
  "video/x-matroska",
]);

export const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

/** Bytes. Raised deliberately; a phone 4K clip is a few hundred MB. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type UploadFolder = "videos" | "thumbnails";

export function isAllowedUpload(folder: UploadFolder, contentType: unknown): boolean {
  if (typeof contentType !== "string") return false;
  const ct = contentType.trim().toLowerCase();
  return folder === "videos" ? VIDEO_TYPES.has(ct) : IMAGE_TYPES.has(ct);
}

export function maxBytesFor(folder: UploadFolder): number {
  return folder === "videos" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

/** Only letters/digits, 1-8 chars; anything else becomes "bin". Stops `../` and `.html`-style games in keys. */
export function safeExtension(filename: unknown, folder: UploadFolder): string {
  const name = typeof filename === "string" ? filename : "";
  const raw = name.includes(".") ? name.split(".").pop() ?? "" : "";
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!ext) return folder === "videos" ? "mp4" : "jpg";
  if (["html", "htm", "svg", "js", "php", "exe"].includes(ext)) return folder === "videos" ? "mp4" : "jpg";
  return ext;
}
