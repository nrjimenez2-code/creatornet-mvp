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

// image/heic and image/heif are deliberately NOT here. They are the libheif
// formats behind GHSA-2xp9-vwfh-vxw4 (RCE in the image optimizer), the composer
// never produces them — thumbnails come from canvas.toBlob(..., "image/jpeg")
// and the picker is accept="image/jpeg,image/png" — and the error message this
// list drives has always promised only "JPG, PNG or WebP". Accepting them
// widened the attack surface past what the product actually offered.
export const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
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


// ---------------------------------------------------------------------------
// Byte-level validation.
//
// The declared Content-Type is chosen by the uploader. Uploads go straight from
// the browser to R2 on a presigned URL, so the bytes never pass through this
// app and nothing has ever checked that a file called "image/jpeg" actually is
// one. sharp sniffs the real format, not the header, so a mislabelled HEIC or
// AVIF still reaches the image optimizer.
//
// The trap this is built around: MP4 and HEIC/AVIF are BOTH ISO-BMFF. Every one
// of them has "ftyp" at offset 4, and only the brand at offset 8 says which.
// A naive "does it start with ftyp" check treats a HEIC as a valid video.

export type MediaKind =
  | "jpeg" | "png" | "gif" | "webp"      // real images
  | "heif" | "avif"                      // ISO-BMFF images — the libheif surface
  | "mp4" | "quicktime" | "webm" | "mpeg" | "3gpp"
  | null;

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...Array.from(b.slice(start, start + len)));

const startsWith = (b: Uint8Array, sig: number[]) =>
  b.length >= sig.length && sig.every((v, i) => b[i] === v);

/** ISO-BMFF brands, lowercased. Kept separate so the two families cannot be confused. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "m4v ", "mmp4"]);

/**
 * Identify a file from its leading bytes. Returns null when the format is not
 * one we recognise — callers must decide what that means rather than guessing.
 * Needs at least 12 bytes to classify an ISO-BMFF file.
 */
export function sniffMediaKind(bytes: Uint8Array): MediaKind {
  if (!bytes || bytes.length < 4) return null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm"; // EBML: WebM/Matroska
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0xba]) || startsWith(bytes, [0x00, 0x00, 0x01, 0xb3])) return "mpeg";

  // ISO-BMFF: "ftyp" at offset 4, brand at offset 8. This is where HEIC, AVIF,
  // MP4, MOV and 3GP all live together.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return "heif";
    if (AVIF_BRANDS.has(brand)) return "avif";
    if (brand.startsWith("qt")) return "quicktime";
    if (brand.startsWith("3g")) return "3gpp";
    if (MP4_BRANDS.has(brand)) return "mp4";
    return null; // an ftyp brand we do not know; let the caller decide
  }
  return null;
}

const KINDS_BY_FOLDER: Record<UploadFolder, Set<MediaKind>> = {
  videos: new Set<MediaKind>(["mp4", "quicktime", "webm", "mpeg", "3gpp"]),
  thumbnails: new Set<MediaKind>(["jpeg", "png", "gif", "webp"]),
};

/**
 * Do these leading bytes belong in this folder?
 *
 * "unknown" is NOT a rejection: it fails open on purpose. The threat this
 * guards is a real HEIC/AVIF reaching the image optimizer, and that is a
 * positively-identified format. Rejecting everything unrecognised would break
 * legitimate but unusual containers for no security gain.
 */
export function bytesAllowedForFolder(folder: UploadFolder, bytes: Uint8Array): boolean {
  const kind = sniffMediaKind(bytes);
  if (kind === null) return true;
  return KINDS_BY_FOLDER[folder].has(kind);
}

/** Bytes needed before sniffMediaKind can classify an ISO-BMFF file. */
export const SNIFF_BYTES = 16;
